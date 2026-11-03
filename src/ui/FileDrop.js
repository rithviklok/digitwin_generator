// ===================================================================
// FileDrop -- turns a plain <input type="file"> into a drop zone: click
// it or drop a file on it, and once a file is attached the zone shows
// its name and size, with a way to remove it.
//
// The <input> stays the single source of truth: callers keep reading
// input.files and listening for its 'change' event (a drop or a removal
// dispatches one too), so nothing else has to know the zone exists.
// ===================================================================

/** 2561 -> "2.6 KB", 283_000_000 -> "283 MB". */
export function fileSizeText(bytes) {
  if (bytes < 1e3) return `${bytes} B`;
  for (const [unit, size] of [['KB', 1e3], ['MB', 1e6], ['GB', 1e9]]) {
    const n = bytes / size;
    if (n < 1000 || unit === 'GB') return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${unit}`;
  }
}

/** Whether `file` matches the input's own `accept` list of extensions (".geojson,.json"). A drop isn't filtered by the browser the way the file picker is. */
function accepts(input, file) {
  const extensions = input.accept.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.startsWith('.'));
  return !extensions.length || extensions.some((ext) => file.name.toLowerCase().endsWith(ext));
}

function span(className, text) {
  const node = document.createElement('span');
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {HTMLInputElement} input - a file input that has an id; it is moved into the new zone, in place
 * @param {{maxBytes?: () => number|null, compact?: boolean}} [opts] - maxBytes: the largest file this slot takes, asked each time a
 *   file is chosen (the limit comes from the server and may arrive after the form is built); null = not known, no check.
 *   compact: a small button-sized zone for a row of optional files (UploadView.js), not a full-width box
 */
export function enhanceFileInput(input, { maxBytes = null, compact = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = compact ? 'file-drop file-drop--compact' : 'file-drop';
  wrap.id = `drop-${input.id}`;
  input.replaceWith(wrap);
  input.classList.add('file-drop__input');

  const zone = document.createElement('label');
  zone.className = 'file-drop__zone';
  zone.htmlFor = input.id;
  const prompt = span('file-drop__prompt');
  prompt.innerHTML = compact ? '<b>Choose file</b> or drop' : '<b>Choose a file</b> or drop it here';
  const chosen = span('file-drop__file');
  const name = span('file-drop__name'), size = span('file-drop__size');
  chosen.append(name, size);
  zone.append(prompt, chosen);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'file-drop__clear';
  clear.textContent = '×';
  const problem = span('file-drop__problem');
  problem.setAttribute('role', 'alert');
  wrap.append(input, zone, clear, problem);

  function render() {
    const file = input.files[0];
    prompt.hidden = Boolean(file);
    chosen.hidden = clear.hidden = !file;
    wrap.classList.toggle('has-file', Boolean(file));
    if (file) {
      name.textContent = file.name;
      size.textContent = fileSizeText(file.size);
      clear.setAttribute('aria-label', `Remove ${file.name}`);
      problem.hidden = true;
    }
  }

  input.addEventListener('change', () => {
    const file = input.files[0], max = maxBytes?.();
    if (file && max && file.size > max) {
      // Turned away here, by name and size, rather than after the whole file
      // has been uploaded -- the server refuses it too, but only once it has
      // arrived. This runs before the form's own 'change' listeners (added
      // after this one), which then see an empty slot.
      input.value = '';
      render();
      problem.textContent = `“${file.name}” is ${fileSizeText(file.size)}, and this server takes files up to ${fileSizeText(max)} here. Choose a smaller area, or ask whoever runs the server to raise its limit.`;
      problem.hidden = false;
      return;
    }
    render();
  });
  clear.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
  });

  zone.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('is-over'); });
  zone.addEventListener('dragleave', () => wrap.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('is-over');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!accepts(input, file)) {
      problem.textContent = `“${file.name}” isn’t a GeoJSON file (${input.accept.replace(/,/g, ' or ')}).`;
      problem.hidden = false;
      return;
    }
    const transfer = new DataTransfer(); // input.files only takes a FileList, and only one file belongs in a slot
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  problem.hidden = true;
  render();
}
