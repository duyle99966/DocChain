/* =========================================================
   DocChain – t.js
   Luồng: Upload -> Extract (JSZip) -> Convert (Mammoth + html2pdf) -> Download
   Mọi thứ chạy trong trình duyệt, không gửi file đi đâu cả.
   ========================================================= */
'use strict';

(() => {
  /* ---------------------------------------------------------
     1. CẤU HÌNH
     --------------------------------------------------------- */
  const CONFIG = {
    concurrency: 3,                        // tối đa 3 file Word chuyển cùng lúc
    warnTotalBytes: 300 * 1024 * 1024,     // cảnh báo khi tổng dung lượng > 300MB
    multiDownloadDelay: 400,               // ms giữa các lần tải khi tải nhiều PDF riêng lẻ
    maxCanvasHeight: 30000,                // px: giới hạn chiều cao canvas an toàn của trình duyệt
    convertTimeout: 180000,                // ms: quá thời gian này coi là lỗi
    logLimit: 600                          // số dòng log tối đa
  };

  const STATUS_LABEL = { pending: 'Pending', converting: 'Converting', done: 'Done', error: 'Error' };
  const CAN_PICK_DIR = typeof window.showDirectoryPicker === 'function';

  const ICONS = {
    zip: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    folder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6m0 0-2.5-2.5M12 17l2.5-2.5"/></svg>'
  };

  /* ---------------------------------------------------------
     2. TRẠNG THÁI TOÀN CỤC
     --------------------------------------------------------- */
  const state = {
    batches: [],            // mỗi file zip = 1 batch (1 block)
    blockCounter: 0,        // số thứ tự Block #
    mode: 'zip',            // 'zip' | 'direct' – cách nhận kết quả
    epoch: 0,               // tăng khi "Làm lại" để hủy các tác vụ đang chạy dở
    queue: Promise.resolve(),
    busy: false,
    zipErrors: 0,           // số file zip không đọc được
    folderNames: new Set()  // tên thư mục/zip đầu ra đã dùng (tránh trùng)
  };

  /* ---------------------------------------------------------
     3. THAM CHIẾU DOM
     --------------------------------------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const els = {
    dropzone: $('#dropzone'),
    fileInput: $('#file-input'),
    steps: [...document.querySelectorAll('.pipeline .step')],
    blocks: $('#blocks'),
    emptyState: $('#empty-state'),
    logBox: $('#log'),
    toasts: $('#toasts'),
    statZips: $('#stat-zips'),
    statDocs: $('#stat-docs'),
    statPdfs: $('#stat-pdfs'),
    statErrors: $('#stat-errors'),
    actionsBar: $('#actions-bar'),
    btnAll: $('#btn-download-all'),
    btnAllFolder: $('#btn-save-folder-all'),
    btnReset: $('#btn-reset'),
    modeInputs: [...document.querySelectorAll('input[name="dlmode"]')],
    modeHint: $('#mode-hint'),
    libWarning: $('#lib-warning')
  };

  /* ---------------------------------------------------------
     4. TIỆN ÍCH CHUNG
     --------------------------------------------------------- */

  /** Tạo phần tử DOM nhanh. Dùng textContent nên tên file lạ cũng không gây XSS. */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'html') el.innerHTML = value;      // chỉ dùng cho hằng số ICONS
      else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    children.flat().forEach(child => {
      if (child == null || child === false) return;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return el;
  }

  const icon = name => h('span', { class: 'icon', html: ICONS[name] });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function formatBytes(bytes) {
    if (bytes == null || Number.isNaN(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024, i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
  }

  const baseName = path => path.split('/').pop();
  const stripExt = name => name.replace(/\.[^./\\]+$/, '');
  const sanitizeFileName = name => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'file';

  /** Bỏ qua thư mục hệ thống, file rác và file tạm của Word ("~$..."). */
  function isJunk(path) {
    return /(^|\/)__MACOSX(\/|$)/.test(path) ||
           /(^|\/)\.DS_Store$/.test(path) ||
           /(^|\/)Thumbs\.db$/i.test(path) ||
           /(^|\/)~\$/.test(path);
  }

  /** Trả về tên chưa dùng: "abc.pdf", "abc (2).pdf", ... */
  function uniqueName(stem, ext, used) {
    let candidate = stem + ext, n = 1;
    while (used.has(candidate.toLowerCase())) { n++; candidate = `${stem} (${n})${ext}`; }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  /**
   * Giải mã tên file trong zip.
   * Ưu tiên UTF-8; nếu không hợp lệ (zip cũ tạo trên Windows) thì thử windows-1258 (tiếng Việt).
   */
  function decodeFileName(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (_) { /* thử tiếp */ }
    try { return new TextDecoder('windows-1258').decode(u8); } catch (_) { /* thử tiếp */ }
    return new TextDecoder('utf-8').decode(u8);
  }

  /** Tính SHA-256 thật bằng Web Crypto. Không khả dụng (trang không an toàn) thì trả về "0x—". */
  async function sha256(buffer) {
    try {
      if (!window.crypto || !crypto.subtle) throw new Error('no crypto.subtle');
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      return { full: '0x' + hex, short: `0x${hex.slice(0, 4)}...${hex.slice(-4)}` };
    } catch (_) {
      return { full: '', short: '0x—' };
    }
  }

  /** Lưu blob về máy: ưu tiên FileSaver, không có thì dùng thẻ <a download>. */
  function saveBlob(blob, filename) {
    if (typeof window.saveAs === 'function') { window.saveAs(blob, filename); return; }
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);   // giải phóng bộ nhớ
  }

  /* ---------------------------------------------------------
     5. LOG, TOAST, THỐNG KÊ, PIPELINE
     --------------------------------------------------------- */
  function log(message, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    els.logBox.append(
      h('div', { class: `log-line log-${type}` },
        h('span', { class: 'log-time', text: `[${time}]` }),
        h('span', { class: 'log-msg', text: message }))
    );
    while (els.logBox.childElementCount > CONFIG.logLimit) els.logBox.firstElementChild.remove();
    els.logBox.scrollTop = els.logBox.scrollHeight;
  }

  function toast(message, type = 'info') {
    const node = h('div', { class: `toast toast-${type}`, role: 'status', text: message });
    els.toasts.append(node);
    setTimeout(() => node.classList.add('is-leaving'), 4600);
    setTimeout(() => node.remove(), 5100);
  }

  function updateStats() {
    let docs = 0, pdfs = 0, errors = state.zipErrors;
    for (const batch of state.batches) {
      for (const entry of batch.entries) {
        docs++;
        if (entry.pdfBlob) pdfs++;
        if (entry.status === 'error') errors++;
      }
    }
    els.statZips.textContent = state.batches.length;
    els.statDocs.textContent = docs;
    els.statPdfs.textContent = pdfs;
    els.statErrors.textContent = errors;
    els.statErrors.closest('.stat').classList.toggle('has-errors', errors > 0);
  }

  /** Bước đang chạy sáng lên, các bước trước đó có dấu tích. index: 0=Upload ... 3=Download */
  function setPipeline(activeIndex) {
    els.steps.forEach((li, i) => {
      li.classList.toggle('is-done', i < activeIndex);
      li.classList.toggle('is-active', i === activeIndex);
    });
  }

  const syncEmptyState = () => { els.emptyState.hidden = state.batches.length > 0; };

  /* ---------------------------------------------------------
     6. NHẬN FILE (Upload)
     --------------------------------------------------------- */
  function handleFiles(fileList) {
    const missing = missingLibs();
    if (missing.length) { toast(`Thiếu thư viện: ${missing.join(', ')}. Kiểm tra kết nối mạng rồi tải lại trang.`, 'error'); return; }

    const zips = [];
    for (const file of fileList) {
      if (/\.zip$/i.test(file.name)) zips.push(file);
      else {
        log(`Từ chối "${file.name}": chỉ chấp nhận file .zip`, 'error');
        toast(`"${file.name}" không phải file .zip nên đã bị bỏ qua.`, 'error');
      }
    }
    if (!zips.length) return;

    // Cảnh báo dung lượng lớn (tính cả các zip đã nạp trước đó)
    const total = zips.reduce((sum, f) => sum + f.size, 0) + state.batches.reduce((sum, b) => sum + b.size, 0);
    if (total > CONFIG.warnTotalBytes) {
      log(`Cảnh báo: tổng dung lượng ${formatBytes(total)} vượt ${formatBytes(CONFIG.warnTotalBytes)}`, 'warn');
      if (!confirm(`Tổng dung lượng là ${formatBytes(total)}. Xử lý file lớn có thể làm trình duyệt chậm hoặc hết bộ nhớ.\n\nBạn vẫn muốn tiếp tục?`)) return;
    }

    // Xếp hàng: các lần thả file liên tiếp được xử lý lần lượt, không chồng chéo
    const epoch = state.epoch;
    state.queue = state.queue
      .then(() => processFiles(zips, epoch))
      .catch(err => { log(`Lỗi không mong muốn: ${err.message}`, 'error'); });
  }

  async function processFiles(files, epoch) {
    if (epoch !== state.epoch) return;          // đã bấm "Làm lại" trong lúc chờ
    state.busy = true;
    refreshActions();
    try {
      setPipeline(0);
      log(`Đã nhận ${files.length} file .zip, bắt đầu xử lý`);

      // --- Bước 2: giải nén tất cả zip trước để danh sách file hiện ra ngay ---
      setPipeline(1);
      const fresh = [];
      for (const file of files) {
        if (epoch !== state.epoch) return;
        log(`Giải nén "${file.name}" (${formatBytes(file.size)})...`);
        try {
          const batch = await extractZip(file);
          if (epoch !== state.epoch) return;
          if (batch) {
            state.batches.push(batch);
            renderBlock(batch);
            fresh.push(batch);
            log(`Block #${pad(batch.no)} tạo xong: ${batch.entries.length} file Word, hash ${batch.hash.short}`, 'ok');
          }
        } catch (err) {
          state.zipErrors++;
          log(`Không giải nén được "${file.name}": ${friendlyZipError(err)}`, 'error');
          toast(`Không đọc được "${file.name}": ${friendlyZipError(err)}`, 'error');
        }
        syncEmptyState();
        updateStats();
      }

      // --- Bước 3: chuyển Word -> PDF, lần lượt từng lô ---
      setPipeline(2);
      for (const batch of fresh) {
        if (epoch !== state.epoch) return;
        await convertBatch(batch, epoch);
      }
      if (epoch !== state.epoch) return;

      // --- Bước 4: sẵn sàng tải ---
      setPipeline(3);
      const pdfs = fresh.reduce((n, b) => n + b.entries.filter(e => e.pdfBlob).length, 0);
      log(`Hoàn tất: ${pdfs} PDF sẵn sàng để tải.`, 'ok');
      if (pdfs) toast(`Đã tạo ${pdfs} PDF. Bạn có thể tải về.`, 'ok');
    } finally {
      if (epoch === state.epoch) {
        state.busy = false;
        refreshActions();
      }
    }
  }

  function friendlyZipError(err) {
    const msg = String(err && err.message || err);
    if (/encrypted/i.test(msg)) return 'file ZIP có đặt mật khẩu, chưa hỗ trợ';
    if (/corrupt|end of central directory|signature/i.test(msg)) return 'file ZIP bị hỏng hoặc không đúng định dạng';
    return msg;
  }

  const pad = n => String(n).padStart(3, '0');

  /* ---------------------------------------------------------
     7. GIẢI NÉN (Extract)
     --------------------------------------------------------- */
  async function extractZip(file) {
    const buffer = await file.arrayBuffer();
    const hash = await sha256(buffer);

    // Cùng nội dung đã nạp rồi thì bỏ qua (giống "block trùng" trong chuỗi)
    if (hash.full && state.batches.some(b => b.hash.full === hash.full)) {
      log(`Bỏ qua "${file.name}": trùng hash với block đã có (${hash.short})`, 'warn');
      toast(`"${file.name}" đã được nạp trước đó nên không thêm lần nữa.`, 'warn');
      return null;
    }

    const zip = await JSZip.loadAsync(buffer, { decodeFileName });

    // Lấy danh sách file, chuẩn hóa Unicode (NFC) để tên tiếng Việt không bị tách dấu
    const files = [];
    zip.forEach((relPath, zipObj) => {
      if (!zipObj.dir) files.push([relPath.normalize('NFC'), zipObj]);
    });
    files.sort((a, b) => a[0].localeCompare(b[0], 'vi', { numeric: true }));

    const no = ++state.blockCounter;
    const usedPdfNames = new Set();
    const entries = [];
    const legacyDocs = [];
    let ignored = 0;

    for (const [path, zipObj] of files) {
      if (isJunk(path)) continue;
      if (/\.docx$/i.test(path)) {
        const name = baseName(path);
        entries.push({
          id: `b${no}-f${entries.length}`,
          path,                                                   // đường dẫn trong zip
          name,                                                   // tên hiển thị
          outName: uniqueName(sanitizeFileName(stripExt(name)), '.pdf', usedPdfNames),  // tên PDF khi tải riêng lẻ
          pdfPath: path.replace(/\.docx$/i, '.pdf'),              // đường dẫn PDF trong zip đầu ra (giữ cấu trúc thư mục)
          size: (zipObj._data && zipObj._data.uncompressedSize) || null,
          zipObj,
          status: 'pending',
          pdfBlob: null,
          error: '',
          ui: null
        });
      } else if (/\.doc$/i.test(path)) {
        legacyDocs.push(path);            // .doc đời cũ: cảnh báo và bỏ qua
      } else {
        ignored++;
      }
    }

    if (legacyDocs.length) {
      log(`"${file.name}": bỏ qua ${legacyDocs.length} file .doc cũ (chỉ hỗ trợ .docx)`, 'warn');
      toast(`"${file.name}" có ${legacyDocs.length} file .doc cũ. Hãy lưu lại thành .docx rồi thử lại.`, 'warn');
    }

    return {
      no,
      name: file.name,
      folderName: uniqueName(sanitizeFileName(stripExt(file.name)), '', state.folderNames),
      size: file.size,
      hash,
      entries,
      legacyDocs,
      ignored,
      status: 'extracted',   // extracted -> converting -> done
      zipBlob: null,         // cache file <tên>_PDF.zip
      ui: null
    };
  }

  /* ---------------------------------------------------------
     8. CHUYỂN ĐỔI (Convert): DOCX -> HTML (Mammoth) -> PDF A4 (html2pdf)
     --------------------------------------------------------- */
  async function convertBatch(batch, epoch) {
    if (!batch.entries.length) {
      batch.status = 'done';
      updateBlock(batch);
      log(`Block #${pad(batch.no)} không có file .docx nào để chuyển`, 'warn');
      return;
    }
    batch.status = 'converting';
    updateBlock(batch);
    log(`Block #${pad(batch.no)}: chuyển ${batch.entries.length} file Word (tối đa ${CONFIG.concurrency} file cùng lúc)`);

    await runPool(batch.entries, CONFIG.concurrency, entry => convertEntry(batch, entry, epoch));
    if (epoch !== state.epoch) return;

    batch.status = 'done';
    updateBlock(batch);
    updateStats();
    refreshActions();
    const ok = batch.entries.filter(e => e.pdfBlob).length;
    const failed = batch.entries.length - ok;
    log(`Block #${pad(batch.no)} xong: ${ok} PDF, ${failed} lỗi`, failed ? 'warn' : 'ok');
  }

  /** Chạy worker cho từng phần tử với tối đa `limit` tác vụ song song. */
  async function runPool(items, limit, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  /** Một file lỗi chỉ đánh dấu Error rồi đi tiếp, không làm dừng cả lô. */
  async function convertEntry(batch, entry, epoch) {
    if (epoch !== state.epoch) return;
    entry.status = 'converting';
    updateRow(entry);
    try {
      const buffer = await entry.zipObj.async('arraybuffer');
      entry.size = buffer.byteLength;
      updateRow(entry);
      const blob = await convertDocxToPdf(buffer, entry.name);
      if (epoch !== state.epoch) return;
      entry.pdfBlob = blob;
      entry.status = 'done';
      log(`Xong: ${entry.name} -> ${entry.outName} (${formatBytes(blob.size)})`, 'ok');
    } catch (err) {
      if (epoch !== state.epoch) return;
      entry.status = 'error';
      entry.error = err && err.message ? err.message : String(err);
      log(`Lỗi "${entry.name}": ${entry.error}`, 'error');
    }
    updateRow(entry);
    updateBlock(batch);
    updateStats();
    await sleep(0);   // nhường trình duyệt vẽ lại giao diện
  }

  async function convertDocxToPdf(arrayBuffer, name) {
    // Bước 1: DOCX -> HTML (Mammoth giữ bảng, danh sách, đậm/nghiêng; ảnh nhúng dạng base64)
    const result = await mammoth.convertToHtml({ arrayBuffer });
    if (!result.value || !result.value.trim()) throw new Error('Tài liệu trống hoặc không đọc được nội dung');

    // Bước 2: dựng HTML vào trang A4 ẩn (Times New Roman, lề 2cm do html2pdf thêm vào)
    const stage = h('div', { class: 'pdf-stage', 'aria-hidden': 'true' });
    const page = h('div', { class: 'pdf-page' });
    page.innerHTML = result.value;
    stage.append(page);
    document.body.append(stage);

    try {
      await waitForImages(page);
      if (document.fonts && document.fonts.ready) await document.fonts.ready;

      // Tài liệu dài -> giảm scale để canvas không vượt giới hạn của trình duyệt
      const height = Math.max(page.scrollHeight, 1);
      const scale = Math.max(1, Math.min(2, CONFIG.maxCanvasHeight / height));
      if (height > CONFIG.maxCanvasHeight) {
        log(`"${name}" rất dài, các trang cuối có thể bị thiếu hoặc trống`, 'warn');
      }

      // Bước 3: HTML -> PDF A4, lề 20mm mỗi cạnh
      const worker = html2pdf().set({
        margin: [20, 20, 20, 20],
        image: { type: 'jpeg', quality: 0.92 },
        html2canvas: { scale, useCORS: true, logging: false, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', 'img', 'h1', 'h2', 'h3'] }
      }).from(page).outputPdf('blob');

      return await withTimeout(worker, CONFIG.convertTimeout, 'Chuyển đổi quá lâu, đã hủy');
    } finally {
      stage.remove();   // luôn dọn vùng dựng, kể cả khi lỗi
    }
  }

  function waitForImages(root) {
    const pending = [...root.querySelectorAll('img')]
      .filter(img => !img.complete)
      .map(img => new Promise(resolve => { img.onload = img.onerror = resolve; }));
    return Promise.all(pending);
  }

  /* ---------------------------------------------------------
     9. ĐÓNG GÓI (Package) & TẢI VỀ (Download)
     --------------------------------------------------------- */

  /** Gom các PDF của một lô thành <tên-zip-gốc>_PDF.zip (có cache). */
  async function packageBatch(batch) {
    if (batch.zipBlob) return batch.zipBlob;
    const zip = new JSZip();
    for (const entry of batch.entries) {
      if (entry.pdfBlob) zip.file(entry.pdfPath, entry.pdfBlob);
    }
    // PDF vốn đã nén sẵn nên dùng STORE cho nhanh
    batch.zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    return batch.zipBlob;
  }

  /** Cách 1: tải zip của một lô. */
  async function downloadBatchZip(batch) {
    const blob = await packageBatch(batch);
    const filename = `${batch.folderName}_PDF.zip`;
    saveBlob(blob, filename);
    log(`Đã tải ${filename} (${formatBytes(blob.size)})`, 'ok');
  }

  /** Cách 1 (tất cả): một zip tổng, mỗi lô nằm trong một thư mục riêng. */
  async function downloadAllZip() {
    const zip = new JSZip();
    let count = 0;
    for (const batch of state.batches) {
      for (const entry of batch.entries) {
        if (!entry.pdfBlob) continue;
        zip.file(`${batch.folderName}/${entry.pdfPath}`, entry.pdfBlob);
        count++;
      }
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    saveBlob(blob, 'DocChain_PDF_ALL.zip');
    log(`Đã tải DocChain_PDF_ALL.zip (${count} PDF, ${formatBytes(blob.size)})`, 'ok');
  }

  /** Cách 2: tải từng file PDF riêng lẻ, không nén. */
  async function downloadDirect(batches) {
    const list = batches.flatMap(b => b.entries.filter(e => e.pdfBlob));
    if (!list.length) return;
    if (list.length > 1) toast('Nếu trình duyệt hỏi cho phép tải nhiều file, hãy chọn Cho phép.', 'info');
    log(`Bắt đầu tải ${list.length} file PDF riêng lẻ...`);
    for (const entry of list) {
      saveBlob(entry.pdfBlob, entry.outName);
      await sleep(CONFIG.multiDownloadDelay);
    }
    log(`Đã gửi ${list.length} file PDF cho trình duyệt tải về`, 'ok');
  }

  /** Cách 2 (nâng cao): ghi thẳng PDF vào thư mục bạn chọn (Chrome / Edge). */
  async function saveToFolder(batches) {
    if (!CAN_PICK_DIR) return;
    let root;
    try {
      root = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // người dùng đóng hộp thoại
      throw err;
    }
    let count = 0;
    for (const batch of batches) {
      const dir = await root.getDirectoryHandle(batch.folderName, { create: true });
      for (const entry of batch.entries) {
        if (!entry.pdfBlob) continue;
        const handle = await dir.getFileHandle(entry.outName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(entry.pdfBlob);
        await writable.close();
        count++;
      }
    }
    log(`Đã lưu ${count} PDF vào thư mục "${root.name}"`, 'ok');
    toast(`Đã lưu ${count} PDF vào thư mục "${root.name}".`, 'ok');
  }

  /** Khóa nút + hiện vòng quay trong lúc chạy, báo lỗi gọn nếu thất bại. */
  async function guarded(button, task) {
    button.disabled = true;
    button.classList.add('is-busy');
    try {
      await task();
    } catch (err) {
      log(`Lỗi khi tải/lưu: ${err.message}`, 'error');
      toast(`Không hoàn tất được: ${err.message}`, 'error');
    } finally {
      button.classList.remove('is-busy');
      state.batches.forEach(updateBlock);
      refreshActions();
    }
  }

  const doneCount = batch => batch.entries.filter(e => e.pdfBlob).length;
  const allDoneCount = () => state.batches.reduce((n, b) => n + doneCount(b), 0);

  /* ---------------------------------------------------------
     10. HIỂN THỊ BLOCK VÀ DÒNG FILE
     --------------------------------------------------------- */
  function renderBlock(batch) {
    const ui = batch.ui = {};

    ui.chip = h('span', { class: 'chip' });
    ui.track = h('div', { class: 'progress-track' }, ui.bar = h('div', { class: 'progress-bar' }));
    ui.progressText = h('span', { class: 'progress-text mono' });
    ui.notes = h('div', { class: 'block-notes' });
    ui.list = h('ul', { class: 'file-list' });

    ui.btnMain = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: () => onBlockMain(batch) });
    ui.btnFolder = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => onBlockFolder(batch) },
      icon('folder'), 'Lưu vào thư mục');

    batch.entries.forEach(entry => {
      entry.ui = renderRow(entry);
      ui.list.append(entry.ui.row);
      updateRow(entry);
    });

    ui.root = h('article', { class: 'block' },
      h('header', { class: 'block-head' },
        h('div', { class: 'block-top' },
          h('span', { class: 'block-num', text: `Block #${pad(batch.no)}` }),
          ui.chip),
        h('h3', { class: 'block-title', title: batch.name, text: batch.name }),
        h('div', { class: 'block-meta mono' },
          h('span', { class: 'hash', title: batch.hash.full || 'SHA-256 không khả dụng (hãy mở qua localhost hoặc https)', text: batch.hash.short }),
          h('span', { text: `${batch.entries.length} file Word` }),
          h('span', { text: formatBytes(batch.size) })),
        h('div', { class: 'block-actions' }, ui.btnMain, ui.btnFolder)),
      h('div', { class: 'progress' }, ui.track, ui.progressText),
      ui.notes,
      ui.list);

    els.blocks.append(ui.root);
    updateBlock(batch);
  }

  function renderRow(entry) {
    const status = h('span', { class: 'file-status' });
    const size = h('span', { class: 'file-size mono' });
    const error = h('p', { class: 'file-error' });
    const button = h('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', title: 'Tải PDF này', 'aria-label': `Tải PDF của ${entry.name}`,
      onClick: () => entry.pdfBlob && saveBlob(entry.pdfBlob, entry.outName)
    }, icon('pdf'), h('span', { class: 'btn-label', text: 'PDF' }));

    const row = h('li', { class: 'file-row' },
      h('span', { class: 'file-ext', text: 'DOCX' }),
      h('span', { class: 'file-name', title: entry.path, text: entry.name }),
      h('span', { class: 'file-meta' }, size, status),
      button,
      error);
    return { row, status, size, button, error };
  }

  function updateRow(entry) {
    const ui = entry.ui;
    if (!ui) return;
    ui.row.dataset.status = entry.status;
    ui.status.textContent = STATUS_LABEL[entry.status];
    ui.size.textContent = formatBytes(entry.size);
    ui.button.disabled = !entry.pdfBlob;
    ui.error.textContent = entry.error;
  }

  function updateBlock(batch) {
    const ui = batch.ui;
    if (!ui) return;
    const total = batch.entries.length;
    const ok = doneCount(batch);
    const failed = batch.entries.filter(e => e.status === 'error').length;
    const finished = ok + failed;
    const pct = total ? Math.round(finished / total * 100) : 100;

    // Trạng thái block
    let view = 'extracted', label = 'Đã giải nén';
    if (batch.status === 'converting') { view = 'converting'; label = 'Đang chuyển đổi'; }
    else if (batch.status === 'done') {
      if (failed) { view = 'partial'; label = 'Xong, có lỗi'; }
      else { view = 'done'; label = 'Hoàn tất'; }
    }
    ui.root.dataset.state = view;
    ui.chip.dataset.state = view;
    ui.chip.textContent = label;

    // Thanh tiến trình
    ui.track.style.setProperty('--p', `${pct}%`);   // CSS variable, không dùng inline style trong HTML
    ui.progressText.textContent = `${finished}/${total} • ${pct}%`;

    // Nút tải theo chế độ đang chọn
    const ready = batch.status === 'done' && ok > 0;
    ui.btnMain.disabled = !ready;
    ui.btnMain.replaceChildren(
      ...(state.mode === 'zip'
        ? [icon('zip'), 'Tải ZIP PDF']
        : [icon('download'), ok ? `Tải ${ok} PDF` : 'Tải PDF']));
    ui.btnFolder.hidden = !(state.mode === 'direct' && CAN_PICK_DIR);
    ui.btnFolder.disabled = !ready;

    // Ghi chú cho người dùng
    const notes = [];
    if (batch.legacyDocs.length) {
      notes.push(h('p', { class: 'note', text: `Đã bỏ qua ${batch.legacyDocs.length} file .doc cũ (chỉ hỗ trợ .docx): ${batch.legacyDocs.map(baseName).join(', ')}` }));
    }
    if (!total) {
      notes.push(h('p', { class: 'note', text: 'Không tìm thấy file .docx nào trong ZIP này.' }));
    }
    if (batch.ignored) {
      notes.push(h('p', { class: 'note note--info', text: `${batch.ignored} file khác (không phải Word) đã được bỏ qua.` }));
    }
    ui.notes.replaceChildren(...notes);
  }

  /* ---------------------------------------------------------
     11. THANH HÀNH ĐỘNG CHUNG VÀ CHẾ ĐỘ NHẬN KẾT QUẢ
     --------------------------------------------------------- */
  const MODE_HINT = {
    zip: 'Nút "Tải tất cả" tạo một file ZIP tổng, mỗi lô nằm trong một thư mục mang tên ZIP gốc.',
    direct: 'Nút "Tải tất cả" tải lần lượt từng file .pdf. Ở từng dòng bạn vẫn có nút tải riêng cho file đó.'
  };

  function applyMode() {
    const checked = els.modeInputs.find(i => i.checked);
    state.mode = checked ? checked.value : 'zip';
    els.modeHint.textContent = MODE_HINT[state.mode];
    state.batches.forEach(updateBlock);
    refreshActions();
  }

  function refreshActions() {
    els.actionsBar.hidden = state.batches.length === 0;
    const total = allDoneCount();
    const ready = !state.busy && total > 0;

    els.btnAll.disabled = !ready;
    els.btnAll.replaceChildren(
      ...(state.mode === 'zip'
        ? [icon('zip'), 'Tải tất cả (ZIP)']
        : [icon('download'), `Tải tất cả ${total} PDF`]));
    els.btnAllFolder.hidden = !(state.mode === 'direct' && CAN_PICK_DIR);
    els.btnAllFolder.disabled = !ready;
  }

  const onBlockMain = batch => guarded(batch.ui.btnMain, () =>
    state.mode === 'zip' ? downloadBatchZip(batch) : downloadDirect([batch]));
  const onBlockFolder = batch => guarded(batch.ui.btnFolder, () => saveToFolder([batch]));

  function resetAll() {
    if (state.busy && !confirm('Đang xử lý dở. Dừng lại và xóa tất cả?')) return;
    state.epoch++;                       // các tác vụ đang chạy sẽ tự hủy khi kiểm tra epoch
    state.queue = Promise.resolve();
    state.busy = false;

    // Bỏ tham chiếu tới blob và zip để trình duyệt thu hồi bộ nhớ
    for (const batch of state.batches) {
      batch.zipBlob = null;
      for (const entry of batch.entries) { entry.pdfBlob = null; entry.zipObj = null; entry.ui = null; }
    }
    state.batches = [];
    state.blockCounter = 0;
    state.zipErrors = 0;
    state.folderNames.clear();

    els.blocks.querySelectorAll('.block').forEach(node => node.remove());
    setPipeline(0);
    updateStats();
    syncEmptyState();
    refreshActions();
    log('Đã xóa tất cả block và giải phóng bộ nhớ.', 'warn');
  }

  /* ---------------------------------------------------------
     12. KHỞI TẠO
     --------------------------------------------------------- */
  function missingLibs() {
    const missing = [];
    if (!window.JSZip) missing.push('JSZip');
    if (!window.mammoth) missing.push('Mammoth.js');
    if (typeof window.html2pdf !== 'function') missing.push('html2pdf.js');
    return missing;
  }

  function bindEvents() {
    els.fileInput.addEventListener('change', () => {
      handleFiles([...els.fileInput.files]);
      els.fileInput.value = '';          // cho phép chọn lại đúng file đó lần sau
    });

    ['dragenter', 'dragover'].forEach(type => els.dropzone.addEventListener(type, e => {
      e.preventDefault();
      els.dropzone.classList.add('is-dragover');
    }));
    ['dragleave', 'dragend'].forEach(type => els.dropzone.addEventListener(type, e => {
      if (type === 'dragleave' && e.relatedTarget && els.dropzone.contains(e.relatedTarget)) return;
      els.dropzone.classList.remove('is-dragover');
    }));
    els.dropzone.addEventListener('drop', e => {
      e.preventDefault();
      els.dropzone.classList.remove('is-dragover');
      handleFiles([...e.dataTransfer.files]);
    });
    // Thả nhầm ra ngoài vùng dropzone thì không để trình duyệt mở file
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => e.preventDefault());

    els.modeInputs.forEach(input => input.addEventListener('change', applyMode));

    els.btnAll.addEventListener('click', () => guarded(els.btnAll, () =>
      state.mode === 'zip' ? downloadAllZip() : downloadDirect(state.batches)));
    els.btnAllFolder.addEventListener('click', () => guarded(els.btnAllFolder, () => saveToFolder(state.batches)));
    els.btnReset.addEventListener('click', resetAll);
  }

  function init() {
    const missing = missingLibs();
    if (missing.length) {
      els.libWarning.hidden = false;
      els.libWarning.textContent = `Không tải được thư viện: ${missing.join(', ')}. Hãy kiểm tra kết nối mạng và tải lại trang.`;
      log(`Thiếu thư viện: ${missing.join(', ')}`, 'error');
    }
    bindEvents();
    applyMode();
    setPipeline(0);
    updateStats();
    syncEmptyState();
    log('DocChain sẵn sàng. Mọi thao tác chạy trong trình duyệt của bạn, không có file nào được gửi đi.', 'ok');
    if (!window.isSecureContext) {
      log('Trang không chạy ở ngữ cảnh bảo mật nên SHA-256 có thể không khả dụng. Hãy mở qua localhost hoặc https.', 'warn');
    }
  }

  init();
})();