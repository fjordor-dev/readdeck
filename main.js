const { Plugin, ItemView, PluginSettingTab, Setting, Notice, requestUrl, Platform } = require("obsidian");

function getDesktopNode(mod) {
  if (typeof Platform === "undefined" || !Platform.isDesktopApp) return null;
  try {
    const req = window["require"];
    return typeof req === "function" ? req(mod) : null;
  } catch (e) {
    return null;
  }
}


function stripWikilink(val) {
  if (!val) return "";
  const s = String(val).trim();
  const m = s.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
  return m ? (m[2] || m[1]).trim() : s;
}

function formatGraphValue(val, asWikilink) {
  const clean = stripWikilink(val);
  if (!clean) return "";
  return asWikilink ? `[[${clean}]]` : clean;
}

function renderFilename(template, data, fallbackTemplate) {
  let out = String(template || fallbackTemplate)
    .replace(/\{\{author\}\}/gi, stripWikilink(data.author || ""))
    .replace(/\{\{director\}\}/gi, stripWikilink(data.director || ""))
    .replace(/\{\{title\}\}/gi, stripWikilink(data.title || ""))
    .replace(/\{\{year\}\}/gi, data.year ? String(data.year) : "");
  out = out.replace(/\(\s*\)/g, "").replace(/\[\s*\]/g, "");
  out = out.replace(/[\\/*?:"<>|]/g, "").replace(/\s+/g, " ").trim();
  out = out.replace(/^[-–—\s]+|[-–—\s]+$/g, "").trim();
  return out || stripWikilink(data.title || "Untitled").replace(/[\\/*?:"<>|]/g, "").trim();
}

function parsePropertyMap(rawJson) {
  if (!rawJson || !String(rawJson).trim()) return {};
  try {
    const parsed = JSON.parse(rawJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

function pKey(propMap, canonical, defaultKey) {
  const custom = propMap && typeof propMap[canonical] === "string" ? propMap[canonical].trim() : "";
  return custom || defaultKey;
}

function getAllDefs(baseDefs, customStr) {
  const list = [...baseDefs];
  const existingKeys = new Set(list.map(d => d.key));
  const parts = String(customStr || "").split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
  for (const name of parts) {
    const key = "custom:" + name.toLowerCase();
    if (!existingKeys.has(key)) {
      list.push({ key, en: name, sv: name, aliases: [name.toLowerCase()] });
      existingKeys.add(key);
    }
  }
  return list;
}

function normalizeDefKey(rawVal, defs, fallbackKey) {
  const v = String(rawVal || "").trim().toLowerCase();
  if (!v) return fallbackKey;
  for (const d of defs) {
    if (d.key === v || d.en.toLowerCase() === v || d.sv.toLowerCase() === v || (d.aliases && d.aliases.includes(v))) {
      return d.key;
    }
  }
  return "custom:" + v;
}

function defKeyToUi(key, defs, fallbackRaw = "") {
  const found = defs.find(d => d.key === key);
  if (found) return found.en;
  if (fallbackRaw) return fallbackRaw;
  if (String(key).startsWith("custom:")) return String(key).slice(7);
  return defs[0]?.en || "";
}

function defKeyToYaml(key, schema, defs) {
  const found = defs.find(d => d.key === key);
  if (found) return schema === "en" ? found.en : found.sv;
  if (String(key).startsWith("custom:")) return String(key).slice(7);
  return schema === "en" ? defs[0].en : defs[0].sv;
}

function safeParseJson(resp) {
  if (!resp) return null;
  try {
    if (typeof resp.text === "string" && resp.text.trim()) return JSON.parse(resp.text);
    return resp.json || null;
  } catch (e) { return null; }
}

function detectValidImageExt(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 200 || arrayBuffer.byteLength > 3 * 1024 * 1024) return null;
  const b = new Uint8Array(arrayBuffer, 0, Math.min(12, arrayBuffer.byteLength));
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}

function applyTemplateTokens(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ""));
}

function parseCsvText(text) {
  const rows = []; let row = []; let cur = ""; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (ch !== "\r") cur += ch;
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.replace(/^\uFEFF/, "").trim().toLowerCase());
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    if (!rows[r].some(c => c.trim())) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (rows[r][idx] || "").trim(); });
    records.push(obj);
  }
  return records;
}

function normalizeCsvDate(raw) {
  if (!raw) return "";
  const m = raw.trim().replace(/\//g, "-").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
}

function insertUnderHeading(content, candidateHeadings, defaultHeading, newBlock) {
  let matchedHeading = null; let idx = -1;
  for (const h of candidateHeadings) {
    const pos = content.indexOf(h);
    if (pos !== -1) { matchedHeading = h; idx = pos; break; }
  }
  if (idx === -1) return content.trimEnd() + `\n\n${defaultHeading}\n${newBlock}\n`;
  const afterHeading = idx + matchedHeading.length;
  const nextMatch = content.slice(afterHeading).match(/\n##\s+/);
  if (nextMatch) {
    const pos = afterHeading + nextMatch.index;
    return `${content.slice(0, pos).trimEnd()}\n${newBlock}\n${content.slice(pos)}`;
  }
  return content.trimEnd() + `\n${newBlock}\n`;
}


async function findVaultEpubViaAdapter(app, vaultEpubFolder, rawLink) {
  const adapter = app.vault.adapter;
  const clean = String(rawLink || "").replace(/[\[\]"]/g, "").split("|")[0].trim();
  if (!clean) return null;
  if (await adapter.exists(clean)) return clean;
  const folder = String(vaultEpubFolder || "").replace(/^\/+|\/+$/g, "");
  if (folder) {
    const direct = `${folder}/${clean}`;
    if (await adapter.exists(direct)) return direct;
    const targetLow = clean.toLowerCase();
    const queue = [folder];
    let safety = 0;
    while (queue.length > 0 && safety++ < 200) {
      const dir = queue.shift();
      let listed;
      try { listed = await adapter.list(dir); } catch (e) { continue; }
      for (const f of (listed.files || [])) {
        const base = f.split("/").pop().toLowerCase();
        if (base === targetLow || f.toLowerCase() === targetLow) return f;
      }
      for (const sub of (listed.folders || [])) queue.push(sub);
    }
  }
  return null;
}

async function ensureVaultFolder(app, folderPath) {
  const parts = String(folderPath || "").split("/").filter(Boolean);
  let curr = "";
  for (const p of parts) {
    curr = curr ? `${curr}/${p}` : p;
    if (!app.vault.getAbstractFileByPath(curr)) await app.vault.createFolder(curr);
  }
}

async function downloadCoverSafely(app, settings, url, baseName, fallbackFolder) {
  if (settings.onlineSearchEnabled === false) return "";
  if (!url || !String(url).startsWith("http")) return url || "";
  try {
    const resp = await requestUrl({ url });
    const ext = detectValidImageExt(resp.arrayBuffer);
    if (!ext) return url;
    const folder = (settings.coversFolder || fallbackFolder).replace(/^\/+|\/+$/g, "");
    await ensureVaultFolder(app, folder);
    const safe = baseName.replace(/[\\/*?:"<>|]/g, "").trim().slice(0, 120);
    const fileName = `${safe}.${ext}`;
    const dest = `${folder}/${fileName}`;
    const existing = app.vault.getAbstractFileByPath(dest);
    if (existing) await app.vault.modifyBinary(existing, resp.arrayBuffer);
    else await app.vault.createBinary(dest, resp.arrayBuffer);
    return `[[${fileName}]]`;
  } catch (e) {
    return url;
  }
}

async function findOrCreateTodayDailyNote(app, settings) {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const coreDaily = app.internalPlugins?.plugins?.["daily-notes"]?.instance?.options || {};
  const fmt = (settings.dailyNoteFormat || coreDaily.format || "YYYY-MM-DD").trim();
  const formatted = typeof window.moment === "function"
    ? window.moment(now).format(fmt)
    : fmt.replace(/YYYY/g, yyyy).replace(/MM/g, mm).replace(/DD/g, dd);

  const baseName = formatted.split("/").pop();
  const folder = (settings.dailyNotesFolder || coreDaily.folder || "").replace(/^\/+|\/+$/g, "");
  const allMd = app.vault.getMarkdownFiles();

  let file = null;
  if (folder) {
    const matches = allMd.filter(f => f.basename === baseName && f.path.startsWith(folder + "/"));
    matches.sort((a, b) => b.path.split("/").length - a.path.split("/").length);
    file = matches[0] || null;
  }
  if (!file) file = allMd.find(f => f.basename === baseName) || null;
  if (!file) {
    let targetDir = folder;
    if (folder) {
      const yearPrefix = `${folder}/${yyyy}/`;
      const sibling = allMd.find(f => {
        if (!f.path.startsWith(yearPrefix)) return false;
        const sub = f.path.slice(yearPrefix.length).split("/")[0] || "";
        return sub.startsWith(mm + " ") || sub === mm;
      });
      if (sibling?.parent) targetDir = sibling.parent.path;
    }
    const relPath = formatted.includes("/") ? formatted : (targetDir ? `${targetDir}/${baseName}` : baseName);
    const fullPath = relPath.endsWith(".md") ? relPath : `${relPath}.md`;
    const parentDir = fullPath.includes("/") ? fullPath.slice(0, fullPath.lastIndexOf("/")) : "";
    if (parentDir) await ensureVaultFolder(app, parentDir);
    file = await app.vault.create(fullPath, `# ${baseName}\n\n`);
  }
  return file;
}

const VIEW_TYPE_SHELF = "readdeck-view";
const VIEW_TYPE_EPUB = "readdeck-epub-view";

const DEFAULT_SETTINGS = {
  booksFolder: "50 Media/Böcker/02 Bok .md",
  indexFolder: "50 Media/Böcker/03 Bokindex",
  vaultEpubFolder: "50 Media/Böcker/01 .epub",
  coversFolder: "99 Obsidian/_Bilagor/Bokomslag",
  saveCoversLocally: true,
  onlineSearchEnabled: true,
  externalLibraryPath: "E:\\Media\\2.0 Books",
  metadataSchema: "sv",
  filenameTemplate: "{{author}} - {{title}}",
  customNoteTemplate: "",
  customStatuses: "",
  propertyMapJson: "",
  ratingScale: 5,
  defaultStatus: "want",
  defaultFormat: "ebook",
  customFormats: "Storytel Reader, Kindle, Audible, Spotify",
  linkAuthor: false,
  linkCategory: false,
  annualGoal: 24,
  mirrorToDailyNote: false,
  dailyNotesFolder: "20 Dagbok & Logg/Dagbok",
  dailyNoteFormat: "YYYY-MM-DD",
  dailyNoteHeading: "## 📖 Läsning",
  dailyNoteMirrorProperties: true,
  dailyNoteMirrorBody: true,
  dailyNoteMinutesProp: "läsning_minuter",
  dailyNoteBooksProp: "läsning",
  readerMode: "paged",
  readerHideToolbar: false,
  readerTheme: "dark",
  readerFontSize: 18,
  readerFontFamily: "serif",
  readerWidth: "normal",
  readerLineHeight: 1.78,
  autoLogMinMinutes: 1
};

const BASE_STATUS_DEFS = [
  { key: "want",      en: "Want to read", sv: "Att läsa",   aliases: ["want to read", "att läsa", "backlog", "to read", "to-read"] },
  { key: "reading",   en: "Reading",      sv: "Läser",      aliases: ["reading", "läser", "påbörjad", "in progress", "currently-reading"] },
  { key: "completed", en: "Completed",    sv: "Lästa",      aliases: ["completed", "lästa", "läst", "finished", "read"] },
  { key: "paused",    en: "Paused",       sv: "Pausad",     aliases: ["paused", "pausad", "on hold"] },
  { key: "dropped",   en: "Dropped",      sv: "Avbruten",   aliases: ["dropped", "avbruten", "dnf", "did-not-finish"] },
  { key: "wishlist",  en: "Wishlist",     sv: "Önskelista", aliases: ["wishlist", "önskelista"] }
];

const BASE_FORMAT_DEFS = [
  { key: "ebook",     en: "E-book",    sv: "E-bok",   aliases: ["e-book", "ebook", "e-bok", "epub", "digital", "fysisk & epub"] },
  { key: "physical",  en: "Physical",  sv: "Fysisk",  aliases: ["physical", "fysisk", "hardcover", "paperback", "mass market paperback"] },
  { key: "audiobook", en: "Audiobook", sv: "Ljudbok", aliases: ["audiobook", "ljudbok", "audio", "audible audio"] },
  { key: "pdf",       en: "PDF",       sv: "PDF",     aliases: ["pdf"] }
];

const READER_WIDTHS = { narrow: "580px", normal: "760px", wide: "980px" };

async function readEpubZip(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error("Invalid EPUB/ZIP file.");
  const cdCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  let pos = cdOffset; const entries = {}; const decoder = new TextDecoder("utf-8");
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    entries[name] = { method, compSize, localOffset };
    pos += 46 + nameLen + extraLen + commentLen;
  }
  async function extractEntry(name) {
    const entry = entries[name];
    if (!entry) return null;
    const lPos = entry.localOffset;
    const dataStart = lPos + 30 + view.getUint16(lPos + 26, true) + view.getUint16(lPos + 28, true);
    const compData = bytes.subarray(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return compData;
    if (entry.method === 8) {
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Blob([compData]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error("Unsupported compression: " + entry.method);
  }
  async function extractText(name) { const d = await extractEntry(name); return d ? decoder.decode(d) : null; }
  return { entries, extractEntry, extractText };
}

class ReadDeckSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.openSections = new Set(["core"]);
  }

  createAccordion(containerEl, key, title) {
    const details = containerEl.createEl("details", { cls: "bs-accordion" });
    if (this.openSections.has(key)) details.setAttr("open", "");
    details.createEl("summary", { text: title });
    details.addEventListener("toggle", () => {
      if (details.open) this.openSections.add(key); else this.openSections.delete(key);
    });
    return details.createDiv({ cls: "bs-accordion-body" });
  }

  addFolderSetting(parentEl, { name, desc, placeholder, value, onSave, datalistId }) {
    return new Setting(parentEl).setName(name).setDesc(desc).addText(text => {
      text.setPlaceholder(placeholder).setValue(value || "").onChange(async val => onSave(val.trim()));
      text.inputEl.addClass("bs-wide-input");
      if (datalistId) text.inputEl.setAttr("list", datalistId);
    });
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("ReadDeck").setHeading();
    containerEl.createDiv({ cls: "bs-settings-hint", text: "Click any section below to expand. Folder fields suggest existing folders in your vault." });

    const datalistId = "bs-vault-folders-list";
    const datalist = containerEl.createEl("datalist", { attr: { id: datalistId } });
    this.app.vault.getAllLoadedFiles()
      .filter(f => Array.isArray(f.children) && f.path && f.path !== "/")
      .map(f => f.path).sort((a, b) => a.localeCompare(b))
      .forEach(p => datalist.createEl("option", { attr: { value: p } }));

    // 1. CORE SETUP
    const coreBody = this.createAccordion(containerEl, "core", "📁 Core Setup");
    this.addFolderSetting(coreBody, {
      name: "Book notes folder (.md)", desc: "Vault folder where new book notes are created.",
      placeholder: "50 Media/Böcker/02 Bok .md", value: this.plugin.settings.booksFolder, datalistId,
      onSave: async v => { this.plugin.settings.booksFolder = v; await this.plugin.saveSettings(); }
    });

    new Setting(coreBody)
      .setName("Online search & remote covers")
      .setDesc("Allow OpenLibrary lookups and remote cover previews. Turn off for 100% offline/private mode.")
      .addToggle(t => t.setValue(this.plugin.settings.onlineSearchEnabled !== false).onChange(async v => {
        this.plugin.settings.onlineSearchEnabled = v; await this.plugin.saveSettings(); this.display();
      }));

    if (this.plugin.settings.onlineSearchEnabled !== false) {
      new Setting(coreBody)
        .setName("Save covers locally (Offline mode)")
        .setDesc("Download validated covers (max 3 MiB) into your vault instead of linking to external URLs.")
        .addToggle(t => t.setValue(Boolean(this.plugin.settings.saveCoversLocally)).onChange(async v => {
          this.plugin.settings.saveCoversLocally = v; await this.plugin.saveSettings(); this.display();
        }));

      if (this.plugin.settings.saveCoversLocally) {
        this.addFolderSetting(coreBody, {
          name: "Local covers folder", desc: "Vault folder where downloaded cover images are stored.",
          placeholder: "99 Obsidian/_Bilagor/Bokomslag", value: this.plugin.settings.coversFolder, datalistId,
          onSave: async v => { this.plugin.settings.coversFolder = v; await this.plugin.saveSettings(); }
        });
      }
    }

    new Setting(coreBody)
      .setName("Annual reading goal (books)")
      .setDesc("Shows a yearly progress bar at the top of Library. Set to 0 to hide.")
      .addText(text => text.setPlaceholder("24").setValue(String(this.plugin.settings.annualGoal ?? 24)).onChange(async v => {
        this.plugin.settings.annualGoal = Math.max(0, parseInt(v, 10) || 0); await this.plugin.saveSettings();
      }));

    // 2. METADATA, TEMPLATES & GRAPH VIEW
    const metaBody = this.createAccordion(containerEl, "meta", "📝 Metadata, Templates & Graph View");
    new Setting(metaBody).setName("Metadata / YAML schema").setDesc("Property names and status values written to notes.")
      .addDropdown(d => d.addOption("sv", "Swedish (typ, författare, Läser, betyg...)").addOption("en", "English (type, author, Reading, rating...)")
        .setValue(this.plugin.settings.metadataSchema || "sv").onChange(async v => { this.plugin.settings.metadataSchema = v; await this.plugin.saveSettings(); }));

    new Setting(metaBody).setName("Filename template").setDesc("Tokens: {{author}}, {{title}}, {{year}}.")
      .addText(t => { t.setPlaceholder("{{author}} - {{title}}").setValue(this.plugin.settings.filenameTemplate || "{{author}} - {{title}}")
        .onChange(async v => { this.plugin.settings.filenameTemplate = v.trim() || "{{author}} - {{title}}"; await this.plugin.saveSettings(); });
        t.inputEl.addClass("bs-wide-input"); });

    new Setting(metaBody).setName("Rating scale").addDropdown(d => d.addOption("5", "1 – 5 (half-steps)").addOption("10", "1 – 10 (half-steps)")
      .setValue(String(this.plugin.settings.ratingScale || 5)).onChange(async v => { this.plugin.settings.ratingScale = Number(v); await this.plugin.saveSettings(); }));

    const statusDefs = getAllDefs(BASE_STATUS_DEFS, this.plugin.settings.customStatuses);
    new Setting(metaBody).setName("Default status for new books").addDropdown(d => {
      for (const s of statusDefs) d.addOption(s.key, s.en);
      d.setValue(this.plugin.settings.defaultStatus || "want").onChange(async v => { this.plugin.settings.defaultStatus = v; await this.plugin.saveSettings(); });
    });

    new Setting(metaBody).setName("Custom reading statuses (Optional)").setDesc("Extra status labels (comma or line separated, e.g. Re-reading, Borrowed).")
      .addTextArea(t => { t.setPlaceholder("Re-reading, Borrowed").setValue(this.plugin.settings.customStatuses || "")
        .onChange(async v => { this.plugin.settings.customStatuses = v; await this.plugin.saveSettings(); }); t.inputEl.rows = 2; t.inputEl.addClass("bs-wide-input"); });

    const formatDefs = getAllDefs(BASE_FORMAT_DEFS, this.plugin.settings.customFormats);
    new Setting(metaBody).setName("Default format for new books").addDropdown(d => {
      for (const f of formatDefs) d.addOption(f.key, f.en);
      d.setValue(this.plugin.settings.defaultFormat || "ebook").onChange(async v => { this.plugin.settings.defaultFormat = v; await this.plugin.saveSettings(); });
    });

    new Setting(metaBody).setName("Custom formats & reading services").setDesc("Comma-separated services added to Format dropdown.")
      .addTextArea(t => { t.setPlaceholder("Storytel Reader, Kindle, Audible, Spotify").setValue(this.plugin.settings.customFormats || "")
        .onChange(async v => { this.plugin.settings.customFormats = v; await this.plugin.saveSettings(); }); t.inputEl.rows = 2; t.inputEl.addClass("bs-wide-input"); });

    new Setting(metaBody).setName("Custom note body template (Optional)")
      .setDesc("Leave blank for default. Tokens: {{title}}, {{author}}, {{cover}}, {{year}}, {{pages}}, {{category}}, {{log_heading}}, {{quotes_heading}}.")
      .addTextArea(t => { t.setPlaceholder("# 📖 {{title}}\n\n{{log_heading}}\n\n{{quotes_heading}}").setValue(this.plugin.settings.customNoteTemplate || "")
        .onChange(async v => { this.plugin.settings.customNoteTemplate = v; await this.plugin.saveSettings(); }); t.inputEl.rows = 4; t.inputEl.addClass("bs-wide-input"); });

    new Setting(metaBody).setName("Custom property names (Optional JSON)")
      .setDesc('Remap YAML keys for new notes, e.g. {"rating":"my_score","status":"read_status"}.')
      .addTextArea(t => { t.setPlaceholder('{"rating":"my_score"}').setValue(this.plugin.settings.propertyMapJson || "")
        .onChange(async v => { this.plugin.settings.propertyMapJson = v.trim(); await this.plugin.saveSettings(); }); t.inputEl.rows = 2; t.inputEl.addClass("bs-wide-input"); });

    new Setting(metaBody).setName("Link Author in Graph View ([[Author]])").addToggle(t => t.setValue(Boolean(this.plugin.settings.linkAuthor))
      .onChange(async v => { this.plugin.settings.linkAuthor = v; await this.plugin.saveSettings(); }));
    new Setting(metaBody).setName("Link Category in Graph View ([[Category]])").addToggle(t => t.setValue(Boolean(this.plugin.settings.linkCategory))
      .onChange(async v => { this.plugin.settings.linkCategory = v; await this.plugin.saveSettings(); }));

    // 3. DAILY NOTES
    const dailyBody = this.createAccordion(containerEl, "daily", "📅 Daily Notes & Reading Log");
    new Setting(dailyBody).setName("Mirror reading sessions to Daily Note").setDesc("Automatically log reading sessions into today's Daily Note.")
      .addToggle(t => t.setValue(Boolean(this.plugin.settings.mirrorToDailyNote)).onChange(async v => {
        this.plugin.settings.mirrorToDailyNote = v; await this.plugin.saveSettings(); this.display();
      }));

    if (this.plugin.settings.mirrorToDailyNote) {
      this.addFolderSetting(dailyBody, {
        name: "Daily Notes root folder", desc: "Nested year/month folders are matched automatically.",
        placeholder: "20 Dagbok & Logg/Dagbok", value: this.plugin.settings.dailyNotesFolder, datalistId,
        onSave: async v => { this.plugin.settings.dailyNotesFolder = v; await this.plugin.saveSettings(); }
      });
      new Setting(dailyBody).setName("Daily Note date format").addText(t => t.setPlaceholder("YYYY-MM-DD").setValue(this.plugin.settings.dailyNoteFormat || "YYYY-MM-DD")
        .onChange(async v => { this.plugin.settings.dailyNoteFormat = v.trim() || "YYYY-MM-DD"; await this.plugin.saveSettings(); }));
      new Setting(dailyBody).setName("Save to Daily Note Properties (YAML)").addToggle(t => t.setValue(this.plugin.settings.dailyNoteMirrorProperties !== false)
        .onChange(async v => { this.plugin.settings.dailyNoteMirrorProperties = v; await this.plugin.saveSettings(); this.display(); }));
      if (this.plugin.settings.dailyNoteMirrorProperties !== false) {
        new Setting(dailyBody).setName("Minutes property name").addText(t => t.setPlaceholder("läsning_minuter").setValue(this.plugin.settings.dailyNoteMinutesProp ?? "läsning_minuter")
          .onChange(async v => { this.plugin.settings.dailyNoteMinutesProp = v.trim(); await this.plugin.saveSettings(); }));
        new Setting(dailyBody).setName("Books property name").addText(t => t.setPlaceholder("läsning").setValue(this.plugin.settings.dailyNoteBooksProp ?? "läsning")
          .onChange(async v => { this.plugin.settings.dailyNoteBooksProp = v.trim(); await this.plugin.saveSettings(); }));
      }
      new Setting(dailyBody).setName("Also append log line in note body").addToggle(t => t.setValue(this.plugin.settings.dailyNoteMirrorBody !== false)
        .onChange(async v => { this.plugin.settings.dailyNoteMirrorBody = v; await this.plugin.saveSettings(); this.display(); }));
      if (this.plugin.settings.dailyNoteMirrorBody !== false) {
        new Setting(dailyBody).setName("Daily Note heading (Optional)").addText(t => t.setPlaceholder("## 📖 Läsning").setValue(this.plugin.settings.dailyNoteHeading || "")
          .onChange(async v => { this.plugin.settings.dailyNoteHeading = v.trim(); await this.plugin.saveSettings(); }));
      }
    }

    // 4. EPUB READER
    const readerBody = this.createAccordion(containerEl, "reader", "📖 EPUB Reader");
    new Setting(readerBody).setName("Default reading width").addDropdown(d => d.addOption("narrow", "Narrow (580px)").addOption("normal", "Normal (760px)").addOption("wide", "Wide (980px)")
      .setValue(this.plugin.settings.readerWidth || "normal").onChange(async v => { this.plugin.settings.readerWidth = v; await this.plugin.saveSettings(); }));
    new Setting(readerBody).setName("Default line spacing").addDropdown(d => d.addOption("1.5", "Compact (1.5)").addOption("1.78", "Comfortable (1.78)").addOption("2.05", "Relaxed (2.05)")
      .setValue(String(this.plugin.settings.readerLineHeight || 1.78)).onChange(async v => { this.plugin.settings.readerLineHeight = Number(v); await this.plugin.saveSettings(); }));
    new Setting(readerBody).setName("Auto-log minimum (minutes)").addText(t => t.setPlaceholder("1").setValue(String(this.plugin.settings.autoLogMinMinutes ?? 1))
      .onChange(async v => { this.plugin.settings.autoLogMinMinutes = Math.max(1, parseInt(v, 10) || 1); await this.plugin.saveSettings(); }));

    // 5. LOCAL ARCHIVE & IMPORT
    const advBody = this.createAccordion(containerEl, "advanced", "🗄️ Local Archive, Mobile Sync & Import");
    this.addFolderSetting(advBody, {
      name: "Vault EPUB/PDF folder (Mobile sync)", desc: "Vault folder where EPUB/PDF files are copied on sync.",
      placeholder: "50 Media/Böcker/01 .epub", value: this.plugin.settings.vaultEpubFolder, datalistId,
      onSave: async v => { this.plugin.settings.vaultEpubFolder = v; await this.plugin.saveSettings(); }
    });
    new Setting(advBody).setName("External e-book library path (Desktop)").setDesc("Local folder scanned recursively for EPUB, PDF, and MOBI.")
      .addText(t => { t.setPlaceholder("E:\\Media\\2.0 Books").setValue(this.plugin.settings.externalLibraryPath || "")
        .onChange(async v => { this.plugin.settings.externalLibraryPath = v.trim(); await this.plugin.saveSettings(); }); t.inputEl.addClass("bs-wide-input"); });
    this.addFolderSetting(advBody, {
      name: "Book index / ghost links folder (Optional)", desc: "Vault folder containing Bokindex / Book Index notes.",
      placeholder: "50 Media/Böcker/03 Bokindex", value: this.plugin.settings.indexFolder, datalistId,
      onSave: async v => { this.plugin.settings.indexFolder = v; await this.plugin.saveSettings(); }
    });
    new Setting(advBody).setName("Import Goodreads / StoryGraph CSV").setDesc("Existing notes are never overwritten.")
      .addButton(btn => btn.setButtonText("📥 Choose CSV & Import").setCta().onClick(() => {
        const inp = createEl("input", { attr: { type: "file", accept: ".csv,text/csv" } });
        inp.onchange = async e => { const f = e.target.files?.[0]; if (f) await this.plugin.importFromCsv(await f.text()); };
        inp.click();
      }));
  }
}

class ReadDeckView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeTab = "library";
    this.findMode = "online";
    this.selectedStatusKey = "all";
    this.selectedFormatKey = "all";
    this.selectedCategory = "All categories";
    this.sortBy = "recent";
    this.searchQuery = "";
    this.compactMode = false;
    this.selectedBookPath = null;
    this.pendingItem = null;
    this.ghostQuery = "";
    this.ghostExtFilter = "ALL";
    this.ghostCache = [];
    this.onlineQuery = "";
    this.onlineResults = [];
    this.onlineLoading = false;
  }

  getViewType() { return VIEW_TYPE_SHELF; }
  getDisplayText() { return "ReadDeck"; }
  getIcon() { return "book-open"; }


  _initDeckMobileFix() {
    if (this._deckMobileInit || !this.contentEl) return;
    this._deckMobileInit = true;
    this.contentEl.addClass("deck-mobile-content");
    if (typeof Platform === "undefined" || !Platform.isMobileApp) return;

    const applyBox = () => {
      const root = this.contentEl?.querySelector(".bs-root, .fs-root");
      if (!root) return;
      const ae = document.activeElement;
      const editing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") && this.contentEl.contains(ae);
      if (editing) {
        const rect = this.contentEl.getBoundingClientRect();
        const padTop = parseFloat(window.getComputedStyle(this.contentEl).paddingTop) || 0;
        const top = Math.max(0, Math.floor(rect.top + padTop));
        const vv = window.visualViewport;
        const vh = vv ? (vv.height + vv.offsetTop) : window.innerHeight;
        const avail = Math.max(200, Math.floor(vh - top));
        root.addClass("deck-kb-open");
        root.style.top = top + "px";
        root.style.height = avail + "px";
      } else {
        root.removeClass("deck-kb-open");
        root.style.top = "";
        root.style.height = "";
      }
    };

    this.contentEl.addEventListener("focusin", (ev) => {
      const el = ev.target;
      if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
      applyBox();
      setTimeout(() => {
        applyBox();
        try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
      }, 260);
    });

    this.contentEl.addEventListener("focusout", () => {
      setTimeout(applyBox, 180);
    });

    this.contentEl.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      const el = ev.target;
      if (!el || (!el.classList?.contains("bs-search") && !el.classList?.contains("fs-search"))) return;
      if (this.activeTab === "library" || this.findMode === "local") {
        ev.preventDefault();
        el.blur();
        this.render();
      }
    });

    this.contentEl.addEventListener("change", (ev) => {
      const el = ev.target;
      if (!el || (!el.classList?.contains("bs-search") && !el.classList?.contains("fs-search"))) return;
      if (this.activeTab === "library" || this.findMode === "local") this.render();
    });

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", applyBox);
      this.register(() => window.visualViewport?.removeEventListener("resize", applyBox));
    }
  }

  async onOpen() {
    this._initDeckMobileFix();
    this.render();
    this._renderTimer = null;
    this.registerEvent(this.app.metadataCache.on("changed", () => {
      if (this.activeTab !== "library") return;
      if (this._renderTimer) window.clearTimeout(this._renderTimer);
      this._renderTimer = window.setTimeout(() => {
        this._renderTimer = null;
        if (this.containerEl && this.containerEl.isConnected && this.activeTab === "library" && !this.contentEl?.contains(document.activeElement)) this.render();
      }, 300);
    }));
  }

  getStatusDefs() { return getAllDefs(BASE_STATUS_DEFS, this.plugin.settings.customStatuses); }
  getFormatDefs() { return getAllDefs(BASE_FORMAT_DEFS, this.plugin.settings.customFormats); }

  getBooks() {
    const statusDefs = this.getStatusDefs();
    const formatDefs = this.getFormatDefs();
    const pm = parsePropertyMap(this.plugin.settings.propertyMapJson);
    const booksFolder = (this.plugin.settings.booksFolder || "").replace(/^\/+|\/+$/g, "");
    const books = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const pLow = file.path.toLowerCase();
      if (pLow.includes("_mallar/") || pLow.includes("mallar/") || pLow.includes("templates/") || file.basename.toLowerCase().includes("bokmall")) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      const rawTitle = fm[pm.title] ?? fm.titel ?? fm.title ?? file.basename;
      if (String(rawTitle).includes("{{")) continue;
      const rawTyp = String(fm[pm.type] ?? fm.typ ?? fm.type ?? "").toLowerCase();
      if (rawTyp === "bok" || rawTyp === "book" || (booksFolder && file.path.startsWith(booksFolder + "/"))) {
        const rawStatus = fm[pm.status] ?? fm.status ?? "Att läsa";
        const rawFormat = fm[pm.format] ?? fm.format ?? "E-bok";
        const rawAuthor = fm[pm.author] ?? fm.författare ?? fm.forfattare ?? fm.author ?? "Unknown Author";
        const rawCat = fm[pm.category] ?? fm.kategori ?? fm.category ?? (Array.isArray(fm.genre) ? fm.genre[0] : fm.genre) ?? "Uncategorized";
        books.push({
          file, path: file.path,
          titel: stripWikilink(rawTitle),
          forfattare: stripWikilink(rawAuthor),
          formatKey: normalizeDefKey(rawFormat, formatDefs, "ebook"),
          formatRaw: String(rawFormat),
          statusKey: normalizeDefKey(rawStatus, statusDefs, "want"),
          betyg: fm[pm.rating] ?? fm.betyg ?? fm.rating ?? "",
          kategori: stripWikilink(rawCat),
          omslag: fm[pm.cover] ?? fm.omslag ?? fm.cover ?? "",
          fil: fm[pm.file] ?? fm.fil ?? fm.file ?? "",
          extern_fil: String(fm[pm.external_file] ?? fm.extern_fil ?? fm.external_file ?? "").replace(/^["']+|["']+$/g, ""),
          startad: String(fm[pm.started] ?? fm.startad ?? fm.started ?? ""),
          avslutad: String(fm[pm.finished] ?? fm.avslutad ?? fm.läst_datum ?? fm.finished ?? ""),
          las_tid: Number(fm[pm.reading_time_minutes] ?? fm.lästid_minuter ?? fm.reading_time_minutes ?? 0),
          progress: Number(fm[pm.progress] ?? fm.progress ?? 0)
        });
      }
    }
    return books;
  }

  resolveCoverUrl(omslagVal) {
    if (!omslagVal) return null;
    if (String(omslagVal).startsWith("http")) {
      return this.plugin.settings.onlineSearchEnabled === false ? null : omslagVal;
    }
    const clean = String(omslagVal).replace(/[\[\]"]/g, "").trim();
    const target = this.app.metadataCache.getFirstLinkpathDest(clean, "");
    return target ? this.app.vault.getResourcePath(target) : null;
  }

  async searchOnlineBooks() {
    if (this.plugin.settings.onlineSearchEnabled === false) {
      new Notice("Online search is disabled in ReadDeck settings.");
      return;
    }
    const q = this.onlineQuery.trim();
    if (!q) return;
    this.onlineLoading = true; this.render();
    try {
      const resp = await requestUrl({ url: `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=24` });
      const docs = safeParseJson(resp)?.docs || [];
      const existingTitles = new Set(this.getBooks().map(b => b.titel.toLowerCase()));
      this.onlineResults = docs.map(d => {
        const title = d.title || "Untitled";
        const author = Array.isArray(d.author_name) && d.author_name.length > 0 ? d.author_name[0] : "Unknown Author";
        return {
          author, title,
          kategori: Array.isArray(d.subject) && d.subject.length > 0 ? d.subject[0] : "Books",
          formatKey: this.plugin.settings.defaultFormat || "ebook",
          statusKey: this.plugin.settings.defaultStatus || "want",
          rating: "",
          coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : "",
          thumbUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : "",
          year: d.first_publish_year || "",
          pages: d.number_of_pages_median || "",
          fullPath: "", vaultFileName: "",
          exists: existingTitles.has(title.toLowerCase())
        };
      });
    } catch (e) {
      new Notice("Online search failed: " + e.message);
      this.onlineResults = [];
    } finally {
      this.onlineLoading = false; this.render();
    }
  }

  async scanAllSources() {
    const existingBooks = this.getBooks();
    const existingNames = new Set(existingBooks.map(b => b.file.basename.toLowerCase()));
    const existingTitles = new Set(existingBooks.map(b => b.titel.toLowerCase()));
    const byKey = new Map();

    for (const f of this.app.vault.getFiles()) {
      const extLow = f.extension.toLowerCase();
      if (extLow !== "epub" && extLow !== "pdf") continue;
      const ext = extLow.toUpperCase();
      const stem = f.basename;
      let author = "Unknown", title = stem;
      if (stem.includes(" - ")) { const p = stem.split(" - "); author = p[0].trim(); title = p.slice(1).join(" - ").trim(); }
      byKey.set(`${author.toLowerCase()}|${title.toLowerCase()}`, {
        linkName: stem, author, title, kategori: "Vault Files", formatKey: ext === "PDF" ? "pdf" : "ebook",
        ext: "VAULT-" + ext, rawExt: ext, fullPath: "", vaultFileName: f.name, hasPhysical: false,
        exists: existingNames.has(stem.toLowerCase()) || existingTitles.has(title.toLowerCase())
      });
    }

    const epubFolder = (this.plugin.settings.vaultEpubFolder || "").replace(/^\/+|\/+$/g, "");
    if (epubFolder && await this.app.vault.adapter.exists(epubFolder)) {
      const queue = [epubFolder];
      let safety = 0;
      while (queue.length > 0 && safety++ < 200) {
        const dir = queue.shift();
        let listed;
        try { listed = await this.app.vault.adapter.list(dir); } catch (e) { continue; }
        for (const fPath of (listed.files || [])) {
          const name = fPath.split("/").pop() || "";
          const m = name.match(/\.(epub|pdf)$/i);
          if (!m) continue;
          const ext = m[1].toUpperCase();
          const stem = name.slice(0, -(m[0].length));
          let author = "Unknown", title = stem;
          if (stem.includes(" - ")) { const p = stem.split(" - "); author = p[0].trim(); title = p.slice(1).join(" - ").trim(); }
          const key = `${author.toLowerCase()}|${title.toLowerCase()}`;
          if (!byKey.has(key)) {
            byKey.set(key, {
              linkName: stem, author, title, kategori: "Vault Files", formatKey: ext === "PDF" ? "pdf" : "ebook",
              ext: "VAULT-" + ext, rawExt: ext, fullPath: "", vaultFileName: name, hasPhysical: false,
              exists: existingNames.has(stem.toLowerCase()) || existingTitles.has(title.toLowerCase())
            });
          }
        }
        for (const sub of (listed.folders || [])) queue.push(sub);
      }
    }

    if (Platform.isDesktopApp) {
      try {
        const fs = getDesktopNode("fs"); const path = getDesktopNode("path");
        const baseDir = this.plugin.settings.externalLibraryPath;
        if (baseDir && fs.existsSync(baseDir)) {
          let scannedDirs = 0; const stack = [baseDir];
          while (stack.length > 0) {
            if (++scannedDirs % 40 === 0) await new Promise(r => setTimeout(r, 0));
            const curr = stack.pop();
            if (path.basename(curr).startsWith("_")) continue;
            let items = []; try { items = fs.readdirSync(curr, { withFileTypes: true }); } catch (e) { continue; }
            for (const it of items) {
              if (it.isSymbolicLink && it.isSymbolicLink()) continue;
              const full = path.join(curr, it.name);
              if (it.isDirectory()) { stack.push(full); continue; }
              const m = it.name.match(/\.(epub|pdf|mobi|azw3)$/i);
              if (!m) continue;
              const ext = m[1].toUpperCase(); const stem = path.parse(it.name).name;
              const relParts = path.relative(baseDir, full).split(path.sep);
              const topCat = relParts.length > 1 ? relParts[0] : "Local Library";
              const parentDir = relParts.length > 2 ? relParts[relParts.length - 2] : "";
              let author = "Unknown", title = stem, linkName = stem;
              if (stem.includes(" - ")) { const p = stem.split(" - "); author = p[0].trim(); title = p.slice(1).join(" - ").trim(); }
              else if (parentDir && parentDir.includes(", ")) { const p = parentDir.split(", "); author = `${p[1].trim()} ${p[0].trim()}`; title = stem.replace(/_/g, " ").trim(); linkName = `${author} - ${title}`; }
              const key = `${author.toLowerCase()}|${title.toLowerCase()}`;
              const prev = byKey.get(key);
              if (!prev || (!prev.vaultFileName && prev.rawExt !== "EPUB" && ext === "EPUB")) {
                byKey.set(key, {
                  linkName, author, title, kategori: topCat, formatKey: ext === "PDF" ? "pdf" : "ebook",
                  ext, rawExt: ext, fullPath: full, vaultFileName: prev?.vaultFileName || "", hasPhysical: prev?.hasPhysical || false,
                  exists: existingNames.has(linkName.toLowerCase()) || existingTitles.has(title.toLowerCase())
                });
              }
            }
          }
        }
      } catch (e) {}
    }

    const indexFolder = (this.plugin.settings.indexFolder || "").replace(/^\/+|\/+$/g, "");
    if (indexFolder) {
      const mdFiles = this.app.vault.getMarkdownFiles().filter(
        f => f.path.startsWith(indexFolder) && (f.basename.startsWith("Bokindex") || f.basename.includes("Fysiska Bokhyllan") || f.basename.includes("Book Index"))
      );
      for (const f of mdFiles) {
        const content = await this.app.vault.read(f);
        const isPhysical = f.basename.includes("Fysiska") || f.basename.toLowerCase().includes("physical");
        const kat = isPhysical ? "Fysiska Böcker" : f.basename.replace(/^(Bokindex|Book Index)\s*-\s*/i, "");
        const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
          const rawTarget = match[1].trim();
          if (rawTarget.startsWith("Bokindex") || rawTarget === "Boköversikt") continue;
          let author = "Unknown", title = rawTarget;
          if (rawTarget.includes(" - ")) { const p = rawTarget.split(" - "); author = p[0].trim(); title = match[2] ? match[2].trim() : p.slice(1).join(" - ").trim(); }
          const key = `${author.toLowerCase()}|${title.toLowerCase()}`;
          if (!byKey.has(key)) {
            byKey.set(key, {
              linkName: rawTarget, author, title, kategori: kat, formatKey: isPhysical ? "physical" : "ebook",
              ext: isPhysical ? "PHYSICAL" : "INDEX", rawExt: isPhysical ? "PHYSICAL" : "INDEX",
              fullPath: "", vaultFileName: "", hasPhysical: isPhysical,
              exists: existingNames.has(rawTarget.toLowerCase()) || existingTitles.has(title.toLowerCase())
            });
          } else if (isPhysical) byKey.get(key).hasPhysical = true;
        }
      }
    }

    this.ghostCache = Array.from(byKey.values()).map(it => {
      const badges = [it.ext];
      if (it.hasPhysical && it.ext !== "PHYSICAL") badges.push("PHYSICAL");
      it.formatLabel = badges.join(" + ");
      return it;
    });
  }

  async safeRefreshMetadata(book) {
    if (this.plugin.settings.onlineSearchEnabled === false) {
      new Notice("Online search is disabled in ReadDeck settings.");
      return;
    }
    const schema = this.plugin.settings.metadataSchema || "sv";
    const pm = parsePropertyMap(this.plugin.settings.propertyMapJson);
    try {
      new Notice("Checking OpenLibrary for missing metadata...");
      const q = encodeURIComponent(`${book.titel} ${book.forfattare}`);
      const resp = await requestUrl({ url: `https://openlibrary.org/search.json?q=${q}&limit=1` });
      const doc = safeParseJson(resp)?.docs?.[0];
      if (!doc) { new Notice("No matching book found on OpenLibrary."); return; }

      let coverVal = "";
      if (!book.omslag && doc.cover_i) {
        const remoteUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
        coverVal = this.plugin.settings.saveCoversLocally
          ? await downloadCoverSafely(this.app, this.plugin.settings, remoteUrl, book.file.basename, "99 Obsidian/_Bilagor/Bokomslag")
          : remoteUrl;
      }

      const updatedFields = [];
      await this.app.fileManager.processFrontMatter(book.file, (fm) => {
        const useSv = schema === "sv" || "omslag" in fm || "typ" in fm;
        const cKey = pKey(pm, "cover", useSv ? "omslag" : "cover");
        const pKeyPages = pKey(pm, "pages", useSv ? "sidor" : "pages");
        const yKey = pKey(pm, "year", useSv ? "utgivningsår" : "published");

        if (coverVal && !fm[cKey]) { fm[cKey] = coverVal; updatedFields.push("cover"); }
        if (doc.number_of_pages_median && !fm[pKeyPages] && !fm.sidor && !fm.pages) { fm[pKeyPages] = doc.number_of_pages_median; updatedFields.push("pages"); }
        if (doc.first_publish_year && !fm[yKey] && !fm.utgivningsår && !fm.published) { fm[yKey] = doc.first_publish_year; updatedFields.push("year"); }
      });

      new Notice(updatedFields.length > 0
        ? `Updated: ${updatedFields.join(", ")} (personal fields preserved).`
        : "All metadata fields are already filled (nothing overwritten).");
      setTimeout(() => this.render(), 250);
    } catch (e) {
      new Notice("Could not refresh metadata: " + e.message);
    }
  }

  async copyEpubToVault(book) {
    if (!Platform.isDesktopApp) { new Notice("External file sync is only available on Desktop."); return; }
    if (!book.extern_fil) { new Notice("No external file path linked."); return; }
    const schema = this.plugin.settings.metadataSchema || "sv";
    try {
      const fs = getDesktopNode("fs"); const path = getDesktopNode("path");
      if (!fs.existsSync(book.extern_fil)) { new Notice("External file not found on disk."); return; }
      const targetFolder = this.plugin.settings.vaultEpubFolder.replace(/^\/+|\/+$/g, "");
      await ensureVaultFolder(this.app, targetFolder);
      const fileName = path.basename(book.extern_fil);
      const vaultDest = `${targetFolder}/${fileName}`;
      if (!(await this.app.vault.adapter.exists(vaultDest))) {
        const buf = fs.readFileSync(book.extern_fil);
        await this.app.vault.adapter.writeBinary(vaultDest, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      }
      await this.app.fileManager.processFrontMatter(book.file, (fm) => {
        const useSv = schema === "sv" || "fil" in fm || "typ" in fm;
        if (useSv) fm.fil = `[[${fileName}]]`; else fm.file = `[[${fileName}]]`;
      });
      new Notice(`Synced ${fileName} to vault!`);
      setTimeout(() => this.render(), 250);
    } catch (e) { new Notice("Error syncing file: " + e.message); }
  }

  openExternally(filePath) {
    if (!Platform.isDesktopApp) { new Notice("External apps cannot be launched on mobile."); return; }
    try { require("electron").shell.openPath(filePath); } catch (e) { new Notice("Could not open externally: " + e.message); }
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();
    const root = container.createDiv({ cls: "bs-root" });
    const topbar = root.createDiv({ cls: "bs-topbar" });
    topbar.createDiv({ cls: "bs-brand", text: "📚 ReadDeck" });

    const tabs = topbar.createDiv({ cls: "bs-tabs" });
    const libTab = tabs.createEl("button", { cls: "bs-tab" + (this.activeTab === "library" ? " active" : ""), text: "Library" });
    libTab.onclick = () => { this.activeTab = "library"; this.pendingItem = null; this.render(); };
    const findTab = tabs.createEl("button", { cls: "bs-tab" + (this.activeTab === "find" ? " active" : ""), text: "Find Book" });
    findTab.onclick = async () => {
      this.activeTab = "find";
      if (this.findMode === "local" && this.ghostCache.length === 0) await this.scanAllSources();
      this.render();
    };

    const workspace = root.createDiv({ cls: "bs-workspace" });
    const main = workspace.createDiv({ cls: "bs-main" });
    if (this.activeTab === "library") this.renderLibrary(main, workspace);
    else this.renderFindBook(main);
  }

  renderLibrary(main, workspace) {
    const statusDefs = this.getStatusDefs();
    const formatDefs = this.getFormatDefs();
    const ratingScale = Number(this.plugin.settings.ratingScale || 5);
    const allBooks = this.getBooks();

    const headerRow = main.createDiv({ cls: "bs-header-row" });
    headerRow.createEl("h2", { text: "Library" });
    const addBtn = headerRow.createEl("button", { cls: "bs-btn bs-btn-accent", text: "+ Add a book" });
    addBtn.onclick = async () => {
      this.activeTab = "find";
      if (this.plugin.settings.onlineSearchEnabled === false) this.findMode = "local";
      if (this.findMode === "local" && this.ghostCache.length === 0) await this.scanAllSources();
      this.render();
    };

    const goalTarget = Number(this.plugin.settings.annualGoal ?? 24);
    if (goalTarget > 0) {
      const yr = String(new Date().getFullYear());
      const finishedYr = allBooks.filter(b => b.statusKey === "completed" && b.avslutad.startsWith(yr)).length;
      const totalMins = allBooks.reduce((a, b) => a + (b.las_tid || 0), 0);
      const pct = Math.min(100, Math.round((finishedYr / goalTarget) * 100));
      const goalCard = main.createDiv({ cls: "bs-goal-card" });
      const top = goalCard.createDiv({ cls: "bs-goal-top" });
      top.createEl("strong", { text: `🎯 ${yr} Reading Goal: ${finishedYr} / ${goalTarget} books (${pct}%)` });
      top.createDiv({ cls: "bs-goal-stats", text: `⏱️ ${Math.floor(totalMins / 60)}h ${totalMins % 60}m logged` });
      const fill = goalCard.createDiv({ cls: "bs-goal-track" }).createDiv({ cls: "bs-goal-fill" });
      fill.style.width = `${pct}%`;
    }

    const controls = main.createDiv({ cls: "bs-controls-row" });
    const searchInput = controls.createEl("input", {
      cls: "bs-search", attr: { type: "text", placeholder: "Search your library by title or author...", value: this.searchQuery }
    });
    searchInput.oninput = (e) => {
      this.searchQuery = e.target.value; if (typeof Platform !== "undefined" && Platform.isMobileApp) return; this.render();
      const el = this.containerEl.querySelector(".bs-search");
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    };

    // Sorting dropdown
    const sortSelect = controls.createEl("select", { cls: "bs-select" });
    [
      { label: "Sort: Recently changed", val: "recent" },
      { label: "Sort: Title A–Z", val: "title" },
      { label: "Sort: Author A–Z", val: "author" },
      { label: "Sort: Highest rated", val: "rating" }
    ].forEach(o => {
      const opt = sortSelect.createEl("option", { text: o.label, value: o.val });
      if (o.val === this.sortBy) opt.selected = true;
    });
    sortSelect.onchange = (e) => { this.sortBy = e.target.value; this.render(); };

    const compactBtn = controls.createEl("button", { cls: "bs-btn", text: this.compactMode ? "🔲 Cover grid" : "☰ Compact list" });
    compactBtn.onclick = () => { this.compactMode = !this.compactMode; this.render(); };

    const pills = main.createDiv({ cls: "bs-pills" });
    const allPill = pills.createDiv({ cls: "bs-pill" + (this.selectedStatusKey === "all" ? " active" : ""), text: `All books ${allBooks.length}` });
    allPill.onclick = () => { this.selectedStatusKey = "all"; this.render(); };
    for (const def of statusDefs) {
      const count = allBooks.filter(b => b.statusKey === def.key).length;
      const pill = pills.createDiv({ cls: "bs-pill" + (this.selectedStatusKey === def.key ? " active" : ""), text: `${def.en} ${count}` });
      pill.onclick = () => { this.selectedStatusKey = def.key; this.render(); };
    }

    const filterRow = main.createDiv({ cls: "bs-controls-row" });
    const fmtSelect = filterRow.createEl("select", { cls: "bs-select" });
    fmtSelect.createEl("option", { text: "All formats", value: "all" });
    for (const def of formatDefs) {
      const opt = fmtSelect.createEl("option", { text: def.en, value: def.key });
      if (def.key === this.selectedFormatKey) opt.selected = true;
    }
    fmtSelect.onchange = (e) => { this.selectedFormatKey = e.target.value; this.render(); };

    const categories = ["All categories", ...new Set(allBooks.map(b => b.kategori).filter(Boolean))];
    const catSelect = filterRow.createEl("select", { cls: "bs-select" });
    for (const c of categories) {
      const opt = catSelect.createEl("option", { text: c, value: c });
      if (c === this.selectedCategory) opt.selected = true;
    }
    catSelect.onchange = (e) => { this.selectedCategory = e.target.value; this.render(); };

    const filtered = allBooks.filter(b => {
      if (this.selectedStatusKey !== "all" && b.statusKey !== this.selectedStatusKey) return false;
      if (this.selectedFormatKey !== "all" && b.formatKey !== this.selectedFormatKey) return false;
      if (this.selectedCategory !== "All categories" && b.kategori !== this.selectedCategory) return false;
      if (this.searchQuery) {
        const q = this.searchQuery.toLowerCase();
        if (!b.titel.toLowerCase().includes(q) && !b.forfattare.toLowerCase().includes(q)) return false;
      }
      return true;
    });

    // Apply sort
    filtered.sort((a, b) => {
      if (this.sortBy === "title") return a.titel.localeCompare(b.titel);
      if (this.sortBy === "author") return a.forfattare.localeCompare(b.forfattare);
      if (this.sortBy === "rating") return (Number(b.betyg) || -1) - (Number(a.betyg) || -1);
      return b.file.stat.mtime - a.file.stat.mtime;
    });

    if (!this.compactMode) {
      const grid = main.createDiv({ cls: "bs-grid" });
      for (const b of filtered) {
        const card = grid.createDiv({ cls: "bs-card" + (this.selectedBookPath === b.path ? " selected" : "") });
        card.onclick = () => { this.selectedBookPath = b.path; this.render(); };
        const cover = card.createDiv({ cls: "bs-cover" });
        const coverUrl = this.resolveCoverUrl(b.omslag);
        if (coverUrl) cover.createEl("img", { attr: { src: coverUrl } });
        else cover.createDiv({ cls: "bs-cover-placeholder", text: `📖\n${b.titel}` });
        if (b.progress > 0) { const pBar = cover.createDiv({ cls: "bs-progress-bar" }); pBar.style.width = `${Math.min(100, b.progress)}%`; }
        card.createDiv({ cls: "bs-card-title", text: b.titel });
        card.createDiv({ cls: "bs-card-sub", text: b.forfattare });
        const meta = card.createDiv({ cls: "bs-card-meta" });
        meta.createSpan({ text: `${defKeyToUi(b.formatKey, formatDefs, b.formatRaw)} • ${defKeyToUi(b.statusKey, statusDefs)}` });
        if (b.betyg !== "" && b.betyg !== null) meta.createSpan({ text: `${b.betyg}/${ratingScale}` });
      }
    } else {
      const list = main.createDiv({ cls: "bs-compact-list" });
      for (const b of filtered) {
        const row = list.createDiv({ cls: "bs-compact-row" + (this.selectedBookPath === b.path ? " selected" : "") });
        row.onclick = () => { this.selectedBookPath = b.path; this.render(); };
        row.createDiv({ text: `${b.titel} — ${b.forfattare}` });
        row.createDiv({ text: `${defKeyToUi(b.formatKey, formatDefs, b.formatRaw)} | ${defKeyToUi(b.statusKey, statusDefs)} | ${b.betyg ? b.betyg + "/" + ratingScale : "-"}` });
      }
    }

    const selectedBook = allBooks.find(b => b.path === this.selectedBookPath);
    if (selectedBook) this.renderSidebar(workspace, selectedBook);
  }

  renderSidebar(workspace, book) {
    const schema = this.plugin.settings.metadataSchema || "sv";
    const pm = parsePropertyMap(this.plugin.settings.propertyMapJson);
    const ratingScale = Number(this.plugin.settings.ratingScale || 5);
    const statusDefs = this.getStatusDefs();
    const formatDefs = this.getFormatDefs();
    const side = workspace.createDiv({ cls: "bs-sidebar" });

    side.createEl("button", { cls: "bs-btn", text: "✕ Close details" }).onclick = () => { this.selectedBookPath = null; this.render(); };
    const top = side.createDiv({ cls: "bs-side-top" });
    const coverBox = top.createDiv({ cls: "bs-side-cover" });
    const coverUrl = this.resolveCoverUrl(book.omslag);
    if (coverUrl) coverBox.createEl("img", { attr: { src: coverUrl } }); else coverBox.createSpan({ text: "📖" });

    const info = top.createDiv({ cls: "bs-side-info" });
    info.createEl("h3", { text: book.titel });
    info.createEl("p", { text: book.forfattare });

    const actions = info.createDiv({ cls: "bs-side-actions" });
    actions.createEl("button", { cls: "bs-btn bs-btn-accent", text: "📄 Open note" }).onclick = () => this.app.workspace.getLeaf("tab").openFile(book.file);

    const extLow = book.extern_fil.toLowerCase();
    const filLow = String(book.fil || "").toLowerCase();
    const isPdf = extLow.endsWith(".pdf") || filLow.includes(".pdf");
    const isExternalOnly = /\.(mobi|azw3|azw|cbr|cbz)$/i.test(extLow);
    if (isExternalOnly) actions.createEl("button", { cls: "bs-btn bs-btn-accent", text: "📂 Open externally" }).onclick = () => this.openExternally(book.extern_fil);
    else if (isPdf) actions.createEl("button", { cls: "bs-btn bs-btn-accent", text: "📕 Open PDF" }).onclick = () => this.openPdfInObsidian(book);
    else actions.createEl("button", { cls: "bs-btn bs-btn-accent", text: "📖 Read EPUB" }).onclick = () => this.plugin.openEpubReader(book);

    const grid = side.createDiv({ cls: "bs-field-grid" });

    const stField = grid.createDiv({ cls: "bs-field" });
    stField.createEl("label", { text: "Reading status" });
    const stSelect = stField.createEl("select");
    for (const def of statusDefs) { const o = stSelect.createEl("option", { text: def.en, value: def.key }); if (def.key === book.statusKey) o.selected = true; }
    stSelect.onchange = async (e) => {
      await this.app.fileManager.processFrontMatter(book.file, (fm) => {
        const useSv = schema === "sv" || "typ" in fm;
        fm[pKey(pm, "status", "status")] = defKeyToYaml(e.target.value, useSv ? "sv" : "en", statusDefs);
        if (e.target.value === "completed" && !fm.avslutad && !fm.finished) {
          fm[pKey(pm, "finished", useSv ? "avslutad" : "finished")] = new Date().toISOString().slice(0, 10);
        }
      });
    };

    const rtField = grid.createDiv({ cls: "bs-field" });
    rtField.createEl("label", { text: `Rating (1–${ratingScale})` });
    const rtInput = rtField.createEl("input", { attr: { type: "number", step: "0.5", min: "1", max: String(ratingScale), value: book.betyg } });
    rtInput.onchange = async (e) => {
      await this.app.fileManager.processFrontMatter(book.file, (fm) => {
        const useSv = schema === "sv" || "betyg" in fm || "typ" in fm;
        fm[pKey(pm, "rating", useSv ? "betyg" : "rating")] = e.target.value === "" ? "" : Number(e.target.value);
      });
    };

    const fmtField = grid.createDiv({ cls: "bs-field" });
    fmtField.createEl("label", { text: "Format / Service" });
    const fSelect = fmtField.createEl("select");
    let matched = false;
    for (const def of formatDefs) { const o = fSelect.createEl("option", { text: def.en, value: def.key }); if (def.key === book.formatKey) { o.selected = true; matched = true; } }
    if (!matched && book.formatRaw) { const o = fSelect.createEl("option", { text: book.formatRaw, value: book.formatKey }); o.selected = true; }
    fSelect.onchange = async (e) => {
      await this.app.fileManager.processFrontMatter(book.file, (fm) => {
        const useSv = schema === "sv" || "typ" in fm;
        fm[pKey(pm, "format", "format")] = defKeyToYaml(e.target.value, useSv ? "sv" : "en", formatDefs);
      });
    };

    const sDateField = grid.createDiv({ cls: "bs-field" });
    sDateField.createEl("label", { text: "Started" });
    sDateField.createEl("input", { attr: { type: "date", value: book.startad } }).onchange = async (e) => {
      await this.app.fileManager.processFrontMatter(book.file, (fm) => {
        const useSv = schema === "sv" || "startad" in fm || "typ" in fm;
        fm[pKey(pm, "started", useSv ? "startad" : "started")] = e.target.value;
      });
    };

    const eDateField = grid.createDiv({ cls: "bs-field" });
    eDateField.createEl("label", { text: "Finished" });
    eDateField.createEl("input", { attr: { type: "date", value: book.avslutad } }).onchange = async (e) => {
      await this.app.fileManager.processFrontMatter(book.file, (fm) => {
        const useSv = schema === "sv" || "avslutad" in fm || "typ" in fm;
        fm[pKey(pm, "finished", useSv ? "avslutad" : "finished")] = e.target.value;
      });
    };

    const pField = grid.createDiv({ cls: "bs-field" });
    pField.createEl("label", { text: "Progress (%)" });
    pField.createEl("input", { attr: { type: "number", min: "0", max: "100", value: book.progress } }).onchange = async (e) => {
      await this.app.fileManager.processFrontMatter(book.file, (fm) => { fm[pKey(pm, "progress", "progress")] = Number(e.target.value); });
    };

    side.createDiv({ text: `⏱️ ${book.las_tid} minutes logged (${book.progress}% read)` });

    const logBox = side.createDiv({ cls: "bs-log-box" });
    logBox.createEl("strong", { text: "Log a session" });
    const noteArea = logBox.createEl("textarea", { attr: { placeholder: "Thoughts or reflection..." } });
    const minInput = logBox.createEl("input", { attr: { type: "number", placeholder: "Minutes read (optional)" } });
    logBox.createEl("button", { cls: "bs-btn bs-btn-accent", text: "Save session" }).onclick = async () => {
      const text = noteArea.value.trim(); const mins = Number(minInput.value || 0);
      if (!text && !mins) return;
      const today = new Date().toISOString().slice(0, 10);
      const entry = `- **${today}**${mins > 0 ? ` *(${mins} min)*` : ""}: ${text}`;
      const content = await this.app.vault.read(book.file);
      const defH = schema === "en" ? "## 💡 Reading Log & Notes" : "## 💡 Tankar & Läspass";
      await this.app.vault.modify(book.file, insertUnderHeading(content, ["## 💡 Tankar & Läspass", "## 💡 Reading Log & Notes"], defH, entry));
      if (mins > 0) {
        await this.app.fileManager.processFrontMatter(book.file, (fm) => {
          const useSv = schema === "sv" || "lästid_minuter" in fm || "typ" in fm;
          const k = pKey(pm, "reading_time_minutes", useSv ? "lästid_minuter" : "reading_time_minutes");
          fm[k] = Number(fm[k] || 0) + mins;
        });
      }
      await this.plugin.mirrorSessionToDailyNote(book, mins, text);
      new Notice("Reading session saved!");
      noteArea.value = ""; minInput.value = "";
    };

    if (this.plugin.settings.onlineSearchEnabled !== false) {
      side.createEl("button", { cls: "bs-btn", text: "🔄 Refresh missing metadata" }).onclick = () => this.safeRefreshMetadata(book);
    }
    if (book.extern_fil && !isExternalOnly && Platform.isDesktopApp) {
      side.createEl("button", { cls: "bs-btn", text: "📲 Sync file to vault (Mobile)" }).onclick = () => this.copyEpubToVault(book);
    }
  }

  async openPdfInObsidian(book) {
    if (book.fil) {
      const target = this.app.metadataCache.getFirstLinkpathDest(String(book.fil).replace(/[\[\]"]/g, "").trim(), "");
      if (target) { this.app.workspace.getLeaf("tab").openFile(target); return; }
    }
    if (book.extern_fil && Platform.isDesktopApp) {
      await this.copyEpubToVault(book);
      const target = this.app.metadataCache.getFirstLinkpathDest(String(book.extern_fil || "").replace(/\\/g, "/").split("/").pop(), "");
      if (target) this.app.workspace.getLeaf("tab").openFile(target);
    }
  }

  openPreviewFor(item) {
    this.pendingItem = {
      title: item.title || "",
      author: item.author || "",
      kategori: item.kategori || (this.plugin.settings.metadataSchema === "en" ? "Books" : "Böcker"),
      year: item.year || "",
      pages: item.pages || "",
      formatKey: item.formatKey || this.plugin.settings.defaultFormat || "ebook",
      statusKey: item.statusKey || this.plugin.settings.defaultStatus || "want",
      rating: item.rating ?? "",
      coverUrl: item.coverUrl || "",
      thumbUrl: item.thumbUrl || item.coverUrl || "",
      saveCoverLocal: Boolean(this.plugin.settings.saveCoversLocally && this.plugin.settings.onlineSearchEnabled !== false),
      fullPath: item.fullPath || "",
      vaultFileName: item.vaultFileName || ""
    };
    this.render();
  }

  renderCreatePreview(main) {
    const it = this.pendingItem;
    const statusDefs = this.getStatusDefs();
    const formatDefs = this.getFormatDefs();
    const ratingScale = Number(this.plugin.settings.ratingScale || 5);

    const card = main.createDiv({ cls: "bs-preview-card" });
    const header = card.createDiv({ cls: "bs-header-row" });
    header.createEl("button", { cls: "bs-btn", text: "← Back" }).onclick = () => { this.pendingItem = null; this.render(); };
    header.createEl("h2", { text: "Preview & Create Book Note" });

    const top = card.createDiv({ cls: "bs-preview-top" });
    const cov = top.createDiv({ cls: "bs-preview-cover" });
    if (it.thumbUrl && this.plugin.settings.onlineSearchEnabled !== false) cov.createEl("img", { attr: { src: it.thumbUrl } });
    else cov.setText("📖");

    const fields = top.createDiv({ cls: "bs-field-grid", attr: { style: "flex:1;width:100%;" } });
    const pathBox = card.createDiv({ cls: "bs-preview-path" });
    const previewDetails = card.createEl("details");
    previewDetails.createEl("summary", { text: "Note preview (YAML & Markdown)", attr: { style: "cursor:pointer;font-size:0.88em;color:var(--text-muted);" } });
    const previewCode = previewDetails.createEl("pre", { cls: "bs-preview-code" });

    const updateLivePreview = () => {
      const built = this.plugin.buildBookNoteData(it);
      const exists = Boolean(this.app.vault.getAbstractFileByPath(built.filePath));
      pathBox.setText((exists ? "⚠️ Already exists: " : "📄 File: ") + built.filePath);
      previewCode.setText(built.content);
    };

    const addInput = (label, key, type = "text", extra = {}) => {
      const f = fields.createDiv({ cls: "bs-field" });
      f.createEl("label", { text: label });
      const inp = f.createEl("input", { attr: { type, value: it[key] ?? "", ...extra } });
      inp.oninput = (e) => { it[key] = e.target.value; updateLivePreview(); };
    };

    addInput("Title", "title");
    addInput("Author", "author");
    addInput("Category", "kategori");
    addInput("Year", "year");

    const stF = fields.createDiv({ cls: "bs-field" });
    stF.createEl("label", { text: "Status" });
    const stS = stF.createEl("select");
    for (const d of statusDefs) { const o = stS.createEl("option", { text: d.en, value: d.key }); if (d.key === it.statusKey) o.selected = true; }
    stS.onchange = (e) => { it.statusKey = e.target.value; updateLivePreview(); };

    const fmtF = fields.createDiv({ cls: "bs-field" });
    fmtF.createEl("label", { text: "Format / Service" });
    const fmS = fmtF.createEl("select");
    for (const d of formatDefs) { const o = fmS.createEl("option", { text: d.en, value: d.key }); if (d.key === it.formatKey) o.selected = true; }
    fmS.onchange = (e) => { it.formatKey = e.target.value; updateLivePreview(); };

    addInput(`Rating (1–${ratingScale})`, "rating", "number", { step: "0.5", min: "1", max: String(ratingScale) });
    addInput("Pages", "pages", "number");

    if (it.coverUrl && this.plugin.settings.onlineSearchEnabled !== false) {
      const chkRow = card.createEl("label", { cls: "bs-checkbox-row" });
      const chk = chkRow.createEl("input", { attr: { type: "checkbox" } });
      chk.checked = Boolean(it.saveCoverLocal);
      chk.onchange = (e) => { it.saveCoverLocal = e.target.checked; updateLivePreview(); };
      chkRow.createSpan({ text: "Save cover locally in vault for offline use" });
    }

    updateLivePreview();

    const createBtn = card.createEl("button", { cls: "bs-btn bs-btn-accent", text: "✓ Create note", attr: { style: "align-self:flex-start;padding:8px 18px;" } });
    createBtn.onclick = async () => {
      if (!it.title.trim()) { new Notice("Please enter a title."); return; }
      const res = await this.plugin.createBookNote(it, false);
      if (res?.file) {
        this.pendingItem = null;
        this.selectedBookPath = res.file.path;
        this.activeTab = "library";
        this.render();
      }
    };
  }

  renderFindBook(main) {
    if (this.pendingItem) { this.renderCreatePreview(main); return; }

    const subtabs = main.createDiv({ cls: "bs-subtabs" });
    const onlineBtn = subtabs.createEl("button", { cls: "bs-btn " + (this.findMode === "online" ? "bs-btn-accent" : ""), text: "🌐 Search Online" });
    onlineBtn.onclick = () => { this.findMode = "online"; this.render(); };
    const localBtn = subtabs.createEl("button", { cls: "bs-btn " + (this.findMode === "local" ? "bs-btn-accent" : ""), text: "📁 Vault & Local Files" });
    localBtn.onclick = async () => { this.findMode = "local"; if (this.ghostCache.length === 0) await this.scanAllSources(); this.render(); };
    const manualBtn = subtabs.createEl("button", { cls: "bs-btn", text: "✏️ + Add manually" });
    manualBtn.onclick = () => this.openPreviewFor({ title: "", author: "", kategori: "Books" });

    if (this.findMode === "online") this.renderOnlineSearch(main);
    else this.renderLocalArchive(main);
  }

  renderOnlineSearch(main) {
    main.createDiv({ cls: "bs-header-row" }).createEl("h2", { text: "Search Online Books" });
    if (this.plugin.settings.onlineSearchEnabled === false) {
      const box = main.createDiv({ cls: "bs-offline-banner" });
      box.createDiv({ text: "Online search is currently turned off in Settings → ReadDeck → Core Setup." });
      box.createEl("button", { cls: "bs-btn bs-btn-accent", text: "✏️ Create manual book note", attr: { style: "align-self:flex-start;" } })
        .onclick = () => this.openPreviewFor({ title: "", author: "", kategori: "Books" });
      return;
    }

    const controls = main.createDiv({ cls: "bs-controls-row" });
    const inp = controls.createEl("input", { cls: "bs-search", attr: { type: "text", placeholder: "Search book title, author, or ISBN (press Enter)...", value: this.onlineQuery } });
    inp.oninput = (e) => { this.onlineQuery = e.target.value; };
    inp.onkeydown = (e) => { if (e.key === "Enter") this.searchOnlineBooks(); };
    controls.createEl("button", { cls: "bs-btn bs-btn-accent", text: this.onlineLoading ? "Searching..." : "🔍 Search" }).onclick = () => this.searchOnlineBooks();

    if (this.onlineLoading) { main.createDiv({ text: "Searching OpenLibrary...", attr: { style: "color:var(--text-muted);margin-top:16px;" } }); return; }
    if (this.onlineResults.length === 0) {
      main.createDiv({ text: "Type a title or author above to search OpenLibrary with covers and metadata.", attr: { style: "color:var(--text-muted);margin-top:16px;" } });
      return;
    }

    const grid = main.createDiv({ cls: "bs-online-grid" });
    for (const item of this.onlineResults) {
      const card = grid.createDiv({ cls: "bs-online-card" });
      const cov = card.createDiv({ cls: "bs-online-cover" });
      if (item.thumbUrl) cov.createEl("img", { attr: { src: item.thumbUrl } }); else cov.setText("📖");
      const body = card.createDiv({ cls: "bs-online-body" });
      body.createDiv({ cls: "bs-online-title", text: item.title });
      body.createDiv({ cls: "bs-online-meta", text: item.author });
      const d = [item.year, item.pages ? `${item.pages} pp.` : ""].filter(Boolean).join(" • ");
      if (d) body.createDiv({ cls: "bs-online-meta", text: d });
      const btn = body.createEl("button", { cls: "bs-btn " + (item.exists ? "" : "bs-btn-accent"), text: item.exists ? "✓ In library" : "Preview & add", attr: { style: "margin-top:auto;align-self:flex-start;" } });
      btn.onclick = () => this.openPreviewFor(item);
    }
  }

  renderLocalArchive(main) {
    const headerRow = main.createDiv({ cls: "bs-header-row" });
    headerRow.createEl("h2", { text: `Vault & Local Archive (${this.ghostCache.length} unique titles)` });
    headerRow.createEl("button", { cls: "bs-btn", text: "🔄 Rescan files" }).onclick = async () => { await this.scanAllSources(); this.render(); };

    const controls = main.createDiv({ cls: "bs-controls-row" });
    const inp = controls.createEl("input", { cls: "bs-search", attr: { type: "text", placeholder: "Filter Vault EPUBs, external library, or index...", value: this.ghostQuery } });
    inp.oninput = (e) => {
      this.ghostQuery = e.target.value; if (typeof Platform !== "undefined" && Platform.isMobileApp) return; this.render();
      const el = this.containerEl.querySelector(".bs-search");
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    };
    const extSel = controls.createEl("select", { cls: "bs-select" });
    [
      { label: "All sources", val: "ALL" }, { label: "In Vault (EPUB/PDF)", val: "VAULT" },
      { label: "EPUB only", val: "EPUB" }, { label: "PDF only", val: "PDF" },
      { label: "MOBI only", val: "MOBI" }, { label: "Physical", val: "PHYSICAL" }
    ].forEach(o => { const opt = extSel.createEl("option", { text: o.label, value: o.val }); if (o.val === this.ghostExtFilter) opt.selected = true; });
    extSel.onchange = (e) => { this.ghostExtFilter = e.target.value; this.render(); };

    const q = this.ghostQuery.toLowerCase().trim();
    const matches = this.ghostCache.filter(it => {
      if (this.ghostExtFilter === "VAULT" && !it.vaultFileName) return false;
      else if (this.ghostExtFilter !== "ALL" && this.ghostExtFilter !== "VAULT" && it.rawExt !== this.ghostExtFilter) return false;
      return !q || it.linkName.toLowerCase().includes(q) || it.author.toLowerCase().includes(q) || it.title.toLowerCase().includes(q) || it.kategori.toLowerCase().includes(q);
    }).slice(0, 75);

    const list = main.createDiv({ cls: "bs-local-list" });
    for (const item of matches) {
      const row = list.createDiv({ cls: "bs-local-item" });
      const left = row.createDiv();
      left.createEl("strong", { text: item.title });
      left.createDiv({ text: `${item.author} • ${item.kategori} [${item.formatLabel}]`, attr: { style: "font-size:0.82em;color:var(--text-muted);" } });
      row.createEl("button", { cls: "bs-btn " + (item.exists ? "" : "bs-btn-accent"), text: item.exists ? "✓ In library" : "Preview & add" })
        .onclick = () => this.openPreviewFor(item);
    }
  }
}

class EpubReaderView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.book = null;
    this.zip = null;
    this.spine = [];
    this.opfDir = "";
    this.currentChapter = 0;
    this.currentPage = 0;
    this.totalPages = 1;
    this.savedRatio = 0;
    this.elapsedSeconds = 0;
    this.timerInterval = null;
    this.timerBadgeEl = null;
    this.toolbarHidden = Boolean(this.plugin.settings.readerHideToolbar);
    this._blobUrls = [];
    this._savePosTimer = null;
    this._resizeObserver = null;
    this._rootEl = null;
    this._pageViewport = null;
    this._pageTrack = null;
    this._contentArea = null;
    this._pageEndSentinel = null;
    this._pageFooterInfo = null;
    this._toggleBarBtn = null;

    this._onVisChange = () => {
      if (document.visibilityState === "hidden" && this.book) {
        this.saveReadingPosition(true);
        this.commitReadingTime(false);
      }
    };
    document.addEventListener("visibilitychange", this._onVisChange);

    this.registerDomEvent(document, "keydown", (e) => {
      if (!this.book || (this.plugin.settings.readerMode || "paged") !== "paged") return;
      if (this.app.workspace.activeLeaf !== this.leaf) return;
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); this.nextPage(); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); this.prevPage(); }
    });
  }

  getViewType() { return VIEW_TYPE_EPUB; }
  getDisplayText() { return this.book ? `📖 ${this.book.titel}` : "EPUB Reader"; }
  getIcon() { return "book"; }

  revokeBlobUrls() {
    if (Array.isArray(this._blobUrls)) {
      for (const u of this._blobUrls) { try { URL.revokeObjectURL(u); } catch (e) {} }
      this._blobUrls = [];
    }
  }

  async toggleToolbar(forceState) {
    this.toolbarHidden = typeof forceState === "boolean" ? forceState : !this.toolbarHidden;
    this.plugin.settings.readerHideToolbar = this.toolbarHidden;
    await this.plugin.saveSettings();
    if (this._rootEl) this._rootEl.toggleClass("bs-toolbar-hidden", this.toolbarHidden);
    if (this._toggleBarBtn) {
      this._toggleBarBtn.setText(this.toolbarHidden ? "☰" : "✕");
      this._toggleBarBtn.setAttribute("aria-label", this.toolbarHidden ? "Show toolbar" : "Hide toolbar");
    }
    if ((this.plugin.settings.readerMode || "paged") === "paged") {
      window.requestAnimationFrame(() => this.layoutPages("ratio"));
    }
  }

  startTimer() {
    this.stopTimer();
    this.timerInterval = window.setInterval(() => {
      if (document.visibilityState === "visible" && this.book) {
        this.elapsedSeconds += 1;
        if (this.timerBadgeEl) {
          this.timerBadgeEl.setText(`⏱️ ${String(Math.floor(this.elapsedSeconds / 60)).padStart(2, "0")}:${String(this.elapsedSeconds % 60).padStart(2, "0")}`);
        }
      }
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) { window.clearInterval(this.timerInterval); this.timerInterval = null; }
  }

  computeOverallProgress() {
    if (!this.spine.length) return 0;
    const frac = (this.currentChapter + (this.currentPage + 1) / Math.max(1, this.totalPages)) / this.spine.length;
    return Math.min(100, Math.max(1, Math.round(frac * 100)));
  }

  scheduleSavePosition() {
    if (this._savePosTimer) window.clearTimeout(this._savePosTimer);
    this._savePosTimer = window.setTimeout(() => {
      this._savePosTimer = null;
      this.saveReadingPosition(true);
    }, 750);
  }

  async saveReadingPosition(immediate = false) {
    if (!this.book || !this.spine.length) return;
    if (!immediate) { this.scheduleSavePosition(); return; }
    if (this._savePosTimer) { window.clearTimeout(this._savePosTimer); this._savePosTimer = null; }

    const schema = this.plugin.settings.metadataSchema || "sv";
    const statusDefs = getAllDefs(BASE_STATUS_DEFS, this.plugin.settings.customStatuses);
    const progress = this.computeOverallProgress();
    const ratio = Number((this.currentPage / Math.max(1, this.totalPages)).toFixed(4));

    try {
      await this.app.fileManager.processFrontMatter(this.book.file, (fm) => {
        const useSv = schema === "sv" || "typ" in fm || "kapitel_index" in fm;
        if (useSv) {
          fm.kapitel_index = this.currentChapter;
          fm.sid_index = this.currentPage;
          fm.las_ratio = ratio;
        } else {
          fm.chapter_index = this.currentChapter;
          fm.page_index = this.currentPage;
          fm.reading_ratio = ratio;
        }
        fm.progress = progress;
        if (normalizeDefKey(fm.status, statusDefs, "want") === "want" && (this.currentChapter > 0 || this.currentPage > 0)) {
          fm.status = defKeyToYaml("reading", useSv ? "sv" : "en", statusDefs);
        }
      });
    } catch (e) {}
  }

  async commitReadingTime(manual = false) {
    if (!this.book) return;
    const minSecs = manual ? 10 : Math.max(1, Number(this.plugin.settings.autoLogMinMinutes || 1)) * 60;
    if (this.elapsedSeconds < minSecs) {
      if (!manual) this.elapsedSeconds = 0;
      else new Notice("Read for at least 10 seconds before logging.");
      return;
    }
    const schema = this.plugin.settings.metadataSchema || "sv";
    const pm = parsePropertyMap(this.plugin.settings.propertyMapJson);
    const mins = Math.max(1, Math.round(this.elapsedSeconds / 60));
    this.elapsedSeconds = 0;
    if (this.timerBadgeEl) this.timerBadgeEl.setText("⏱️ 00:00");
    const today = new Date().toISOString().slice(0, 10);
    const noteText = `Chapter ${this.currentChapter + 1}, p. ${this.currentPage + 1}`;
    const entry = `- **${today}** *(${mins} min EPUB session)* — ${noteText}`;
    const content = await this.app.vault.read(this.book.file);
    const defH = schema === "en" ? "## 💡 Reading Log & Notes" : "## 💡 Tankar & Läspass";
    await this.app.vault.modify(this.book.file, insertUnderHeading(content, ["## 💡 Tankar & Läspass", "## 💡 Reading Log & Notes"], defH, entry));
    await this.app.fileManager.processFrontMatter(this.book.file, (fm) => {
      const useSv = schema === "sv" || "lästid_minuter" in fm || "typ" in fm;
      const k = pKey(pm, "reading_time_minutes", useSv ? "lästid_minuter" : "reading_time_minutes");
      fm[k] = Number(fm[k] || 0) + mins;
    });
    await this.plugin.mirrorSessionToDailyNote(this.book, mins, noteText);
    new Notice(`Logged ${mins} minutes!`);
  }

  async onClose() {
    document.removeEventListener("visibilitychange", this._onVisChange);
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    this.stopTimer();
    await this.saveReadingPosition(true);
    await this.commitReadingTime(false);
    this.revokeBlobUrls();
    this.zip = null;
  }

  async readSavedBookmark(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    let ch = Number(fm.kapitel_index ?? fm.chapter_index ?? NaN);
    let pg = Number(fm.sid_index ?? fm.page_index ?? NaN);
    let rt = Number(fm.las_ratio ?? fm.reading_ratio ?? NaN);

    if (Number.isNaN(ch) || Number.isNaN(pg)) {
      try {
        const raw = await this.app.vault.read(file);
        const head = raw.slice(0, 1500);
        const mCh = head.match(/^(?:kapitel_index|chapter_index):\s*(\d+)/m);
        const mPg = head.match(/^(?:sid_index|page_index):\s*(\d+)/m);
        const mRt = head.match(/^(?:las_ratio|reading_ratio):\s*([0-9.]+)/m);
        if (mCh) ch = Number(mCh[1]);
        if (mPg) pg = Number(mPg[1]);
        if (mRt) rt = Number(mRt[1]);
      } catch (e) {}
    }
    return {
      chapter: Number.isFinite(ch) && ch >= 0 ? ch : 0,
      page: Number.isFinite(pg) && pg >= 0 ? pg : 0,
      ratio: Number.isFinite(rt) && rt >= 0 ? rt : 0
    };
  }

  async loadBook(book) {
    if (this.book && this.book.path !== book.path) {
      await this.saveReadingPosition(true);
      await this.commitReadingTime(false);
    }
    this.book = book;
    this.elapsedSeconds = 0;

    const bm = await this.readSavedBookmark(book.file);
    this.currentChapter = bm.chapter;
    this.currentPage = bm.page;
    this.savedRatio = bm.ratio;

    let arrayBuffer = null;
    if (book.fil) {
      const cleanLink = String(book.fil).replace(/[\[\]"]/g, "").split("|")[0].trim();
      const vf = this.app.metadataCache.getFirstLinkpathDest(cleanLink, "");
      if (vf) {
        arrayBuffer = await this.app.vault.readBinary(vf);
      } else if (typeof findVaultEpubViaAdapter === "function") {
        const adapterPath = await findVaultEpubViaAdapter(this.app, this.plugin.settings.vaultEpubFolder, cleanLink);
        if (adapterPath) arrayBuffer = await this.app.vault.adapter.readBinary(adapterPath);
      }
    }
    if (!arrayBuffer && book.extern_fil && Platform.isDesktopApp) {
      try {
        const fs = getDesktopNode("fs");
        const clean = String(book.extern_fil).replace(/^["']+|["']+$/g, "").trim();
        if (fs.existsSync(clean)) {
          const b = fs.readFileSync(clean);
          arrayBuffer = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        }
      } catch (e) {}
    }
    if (!arrayBuffer) { new Notice("No EPUB file linked to this book."); return; }

    try {
      this.revokeBlobUrls();
      this.zip = null;
      this.zip = await readEpubZip(arrayBuffer);
      const cXml = await this.zip.extractText("META-INF/container.xml");
      const opfMatch = cXml?.match(/full-path="([^"]+)"/);
      if (!opfMatch) throw new Error("OPF manifest not found.");
      const opfPath = decodeURIComponent(opfMatch[1]);
      this.opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
      const opfXml = await this.zip.extractText(opfPath);
      if (!opfXml) throw new Error("Could not read OPF manifest.");
      const doc = new DOMParser().parseFromString(opfXml, "application/xml");
      const manifest = {};
      doc.querySelectorAll("manifest > item").forEach(it => { manifest[it.getAttribute("id")] = it.getAttribute("href"); });
      this.spine = [];
      doc.querySelectorAll("spine > itemref").forEach(ref => {
        const id = ref.getAttribute("idref");
        if (manifest[id]) this.spine.push(this.opfDir + manifest[id]);
      });
      if (!this.spine.length) throw new Error("No readable chapters found in EPUB.");
      if (this.currentChapter >= this.spine.length) {
        this.currentChapter = 0;
        this.currentPage = 0;
        this.savedRatio = 0;
      }
      this.startTimer();
      await this.renderReader("bookmark");
    } catch (e) {
      console.error("ReadDeck EPUB error:", e);
      new Notice("Could not open EPUB: " + (e?.message || e));
    }
  }

  layoutPages(mode = "keep") {
    if (!this._pageViewport || !this._pageTrack || !this._contentArea) return;
    const vpW = this._pageViewport.clientWidth;
    const vpH = this._pageViewport.clientHeight;
    if (vpW < 80 || vpH < 80) {
      window.requestAnimationFrame(() => this.layoutPages(mode));
      return;
    }

    const sidePad = vpW < 640 ? 18 : 44;
    const colW = Math.max(180, vpW - sidePad * 2);
    const gap = sidePad * 2;

    this._contentArea.style.width = `${vpW}px`;
    this._contentArea.style.height = `${vpH}px`;
    this._contentArea.style.padding = `14px ${sidePad}px`;
    this._contentArea.style.columnWidth = `${colW}px`;
    this._contentArea.style.columnGap = `${gap}px`;

    const maxImgH = Math.max(140, vpH - 48);
    this._contentArea.querySelectorAll("img").forEach(img => { img.style.maxHeight = `${maxImgH}px`; });

    let total = 1;
    if (this._pageEndSentinel) {
      const contentLeft = this._contentArea.getBoundingClientRect().left;
      const endLeft = this._pageEndSentinel.getBoundingClientRect().left;
      const span = endLeft - contentLeft;
      total = Math.max(1, Math.floor(Math.max(0, span - 4) / vpW) + 1);
    } else {
      total = Math.max(1, Math.round(this._contentArea.scrollWidth / vpW));
    }
    this.totalPages = total;

    if (mode === "end") {
      this.currentPage = total - 1;
    } else if (mode === "ratio" && this.savedRatio > 0) {
      this.currentPage = Math.min(total - 1, Math.max(0, Math.round(this.savedRatio * total)));
    } else {
      this.currentPage = Math.min(total - 1, Math.max(0, this.currentPage));
    }

    this.savedRatio = this.currentPage / Math.max(1, this.totalPages);
    this._pageTrack.style.transform = `translate3d(-${this.currentPage * vpW}px, 0, 0)`;

    if (this._pageFooterInfo) {
      this._pageFooterInfo.setText(
        `Page ${this.currentPage + 1}/${this.totalPages} • Ch. ${this.currentChapter + 1}/${this.spine.length} (${this.computeOverallProgress()}%)`
      );
    }
  }

  async goToPage(pageIdx) {
    if (pageIdx >= this.totalPages) {
      if (this.currentChapter + 1 < this.spine.length) {
        await this.changeChapter(this.currentChapter + 1, "start");
      } else {
        new Notice("You've reached the end of the book.");
      }
      return;
    }
    if (pageIdx < 0) {
      if (this.currentChapter > 0) {
        await this.changeChapter(this.currentChapter - 1, "end");
      } else {
        new Notice("Already at the first page.");
      }
      return;
    }
    this.currentPage = pageIdx;
    this.layoutPages("keep");
    this.scheduleSavePosition();
  }

  nextPage() { return this.goToPage(this.currentPage + 1); }
  prevPage() { return this.goToPage(this.currentPage - 1); }

  async renderReader(landing = "keep") {
    const container = this.containerEl.children[1];
    container.empty();
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }

    this.toolbarHidden = Boolean(this.plugin.settings.readerHideToolbar);
    const theme = this.plugin.settings.readerTheme || "dark";
    const fontSize = Number(this.plugin.settings.readerFontSize || 18);
    const fontFam = this.plugin.settings.readerFontFamily || "serif";
    const widthKey = this.plugin.settings.readerWidth || "normal";
    const lineHeight = Number(this.plugin.settings.readerLineHeight || 1.78);
    const readerMode = this.plugin.settings.readerMode || "paged";

    const root = container.createDiv({ cls: `bs-reader-root theme-${theme}${this.toolbarHidden ? " bs-toolbar-hidden" : ""}` });
    this._rootEl = root;
    const toolbar = root.createDiv({ cls: "bs-reader-toolbar" });

    const navG = toolbar.createDiv({ cls: "bs-reader-group" });
    navG.createEl("button", { cls: "bs-btn", text: "◀" }).onclick = () => this.changeChapter(this.currentChapter - 1, "start");
    const chapSel = navG.createEl("select", { cls: "bs-select" });
    this.spine.forEach((_, i) => {
      const o = chapSel.createEl("option", { text: `Ch. ${i + 1} / ${this.spine.length}`, value: String(i) });
      if (i === this.currentChapter) o.selected = true;
    });
    chapSel.onchange = (e) => this.changeChapter(Number(e.target.value), "start");
    navG.createEl("button", { cls: "bs-btn", text: "▶" }).onclick = () => this.changeChapter(this.currentChapter + 1, "start");

    const stG = toolbar.createDiv({ cls: "bs-reader-group" });
    stG.createEl("button", { cls: "bs-btn", text: readerMode === "paged" ? "📖 Pages" : "📜 Scroll" }).onclick = async () => {
      this.plugin.settings.readerMode = readerMode === "paged" ? "scroll" : "paged";
      await this.plugin.saveSettings();
      await this.renderReader("keep");
    };

    const thSel = stG.createEl("select", { cls: "bs-select" });
    [{ l: "🌑 Dark", v: "dark" }, { l: "📜 Sepia", v: "sepia" }, { l: "☀️ Light", v: "light" }].forEach(t => {
      const o = thSel.createEl("option", { text: t.l, value: t.v });
      if (t.v === theme) o.selected = true;
    });
    thSel.onchange = async (e) => { this.plugin.settings.readerTheme = e.target.value; await this.plugin.saveSettings(); await this.renderReader("ratio"); };

    stG.createEl("button", { cls: "bs-btn", text: "A−" }).onclick = async () => {
      this.plugin.settings.readerFontSize = Math.max(13, fontSize - 2);
      await this.plugin.saveSettings();
      await this.renderReader("ratio");
    };
    stG.createEl("button", { cls: "bs-btn", text: "A+" }).onclick = async () => {
      this.plugin.settings.readerFontSize = Math.min(32, fontSize + 2);
      await this.plugin.saveSettings();
      await this.renderReader("ratio");
    };
    stG.createEl("button", { cls: "bs-btn", text: fontFam === "serif" ? "Serif" : "Sans" }).onclick = async () => {
      this.plugin.settings.readerFontFamily = fontFam === "serif" ? "sans" : "serif";
      await this.plugin.saveSettings();
      await this.renderReader("ratio");
    };

    if (readerMode === "scroll") {
      const wSel = stG.createEl("select", { cls: "bs-select" });
      [{ l: "↔ Narrow", v: "narrow" }, { l: "↔ Normal", v: "normal" }, { l: "↔ Wide", v: "wide" }].forEach(w => {
        const o = wSel.createEl("option", { text: w.l, value: w.v });
        if (w.v === widthKey) o.selected = true;
      });
      wSel.onchange = async (e) => { this.plugin.settings.readerWidth = e.target.value; await this.plugin.saveSettings(); await this.renderReader("keep"); };
    }

    const lhSel = stG.createEl("select", { cls: "bs-select" });
    ["1.5", "1.78", "2.05"].forEach(v => {
      const o = lhSel.createEl("option", { text: `↕ ${v}`, value: v });
      if (Number(v) === lineHeight) o.selected = true;
    });
    lhSel.onchange = async (e) => { this.plugin.settings.readerLineHeight = Number(e.target.value); await this.plugin.saveSettings(); await this.renderReader("ratio"); };

    const rG = toolbar.createDiv({ cls: "bs-reader-group" });
    this.timerBadgeEl = rG.createDiv({
      cls: "bs-timer-badge",
      text: `⏱️ ${String(Math.floor(this.elapsedSeconds / 60)).padStart(2, "0")}:${String(this.elapsedSeconds % 60).padStart(2, "0")}`
    });
    rG.createEl("button", { cls: "bs-btn", text: "💾 Log" }).onclick = () => this.commitReadingTime(true);
    rG.createEl("button", { cls: "bs-btn bs-btn-accent", text: "💬 Quote" }).onclick = () => this.saveSelectionAsQuote();
    rG.createEl("button", { cls: "bs-btn bs-btn-icon", text: "⛶", attr: { title: "Hide toolbar" } }).onclick = () => this.toggleToolbar(true);

    let contentArea;
    if (readerMode === "paged") {
      this._toggleBarBtn = null;
      const viewport = root.createDiv({ cls: "bs-page-viewport" });
      const track = viewport.createDiv({ cls: "bs-page-track" });
      contentArea = track.createDiv({ cls: "bs-reader-content paged" });
      this._pageViewport = viewport;
      this._pageTrack = track;
      this._contentArea = contentArea;

      let touchStartX = 0, touchStartY = 0, touchMoved = false, swiped = false;
      viewport.addEventListener("touchstart", (e) => {
        if (e.touches.length === 1) {
          e.stopPropagation();
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
          touchMoved = false;
          swiped = false;
        }
      }, { passive: true });

      viewport.addEventListener("touchmove", (e) => {
        if (e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - touchStartX;
        const dy = e.touches[0].clientY - touchStartY;
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) touchMoved = true;
        if (Math.abs(dx) > Math.abs(dy)) {
          e.stopPropagation();
          e.preventDefault();
        }
      }, { passive: false });

      viewport.addEventListener("touchend", (e) => {
        if (e.changedTouches.length !== 1) return;
        e.stopPropagation();
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) > 32 && Math.abs(dx) > Math.abs(dy) * 1.1) {
          swiped = true;
          if (dx < 0) this.nextPage();
          else this.prevPage();
        }
      }, { passive: true });

      viewport.addEventListener("click", (e) => {
        if (swiped || touchMoved) { swiped = false; touchMoved = false; return; }
        if (window.getSelection()?.toString().trim()) return;
        const rect = viewport.getBoundingClientRect();
        const relX = e.clientX - rect.left;
        if (relX < rect.width * 0.33) this.prevPage();
        else if (relX > rect.width * 0.67) this.nextPage();
        else this.toggleToolbar();
      });

      const footer = root.createDiv({ cls: "bs-page-footer" });
      footer.createEl("button", { cls: "bs-btn", text: "◀ Prev" }).onclick = () => this.prevPage();
      this._toggleBarBtn = footer.createEl("button", {
        cls: "bs-btn bs-btn-icon",
        text: this.toolbarHidden ? "☰" : "✕",
        attr: { title: "Toggle top toolbar" }
      });
      this._toggleBarBtn.onclick = () => this.toggleToolbar();
      this._pageFooterInfo = footer.createDiv({ cls: "bs-page-footer-info", text: "Loading pages..." });
      footer.createEl("button", { cls: "bs-btn", text: "Next ▶" }).onclick = () => this.nextPage();
    } else {
      this._pageViewport = null;
      this._pageTrack = null;
      this._pageFooterInfo = null;
      this._toggleBarBtn = null;
      contentArea = root.createDiv({ cls: "bs-reader-scroll" }).createDiv({ cls: "bs-reader-content" });
      contentArea.style.maxWidth = READER_WIDTHS[widthKey] || "760px";
      this._contentArea = contentArea;
      const restoreBtn = root.createEl("button", { cls: "bs-btn bs-scroll-restore-btn", text: "☰ Controls" });
      restoreBtn.onclick = () => this.toggleToolbar(false);
    }

    contentArea.style.fontSize = `${fontSize}px`;
    contentArea.style.fontFamily = fontFam === "serif" ? "Georgia, 'Times New Roman', serif" : "var(--font-text)";
    contentArea.style.lineHeight = String(lineHeight);

    const chapPath = decodeURIComponent(this.spine[this.currentChapter] || "");
    const rawHtml = await this.zip.extractText(chapPath);
    if (!rawHtml) { contentArea.setText("Could not load chapter."); return; }

    this.revokeBlobUrls();
    const cleaned = rawHtml.replace(/<a\b[^>]*\/\s*>/gi, "");
    const htmlDoc = new DOMParser().parseFromString(cleaned, "text/html");
    const chapDir = chapPath.includes("/") ? chapPath.slice(0, chapPath.lastIndexOf("/") + 1) : "";
    htmlDoc.querySelectorAll("script, style, iframe, object, svg").forEach(el => el.remove());
    htmlDoc.querySelectorAll("a").forEach(a => {
      if (!a.childElementCount) {
        const s = htmlDoc.createElement("span"); s.textContent = a.textContent; a.replaceWith(s);
      } else {
        a.removeAttribute("href");
      }
    });

    const imgs = Array.from(htmlDoc.querySelectorAll("img"));
    for (let idx = 0; idx < imgs.length; idx++) {
      if (idx > 0 && idx % 6 === 0) await new Promise(r => setTimeout(r, 0));
      const img = imgs[idx];
      const src = img.getAttribute("src");
      if (!src || src.startsWith("http") || src.startsWith("data:")) continue;
      try {
        const resolved = new URL(src, "http://epub.local/" + chapDir).pathname.slice(1);
        const key = decodeURIComponent(resolved);
        const entry = this.zip?.entries?.[key];
        if (!entry || (Platform.isMobileApp && entry.compSize > 3 * 1024 * 1024)) { img.remove(); continue; }
        const bytes = await this.zip.extractEntry(key);
        if (bytes) {
          const ext = key.split(".").pop()?.toLowerCase() || "";
          const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
          const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
          this._blobUrls.push(url);
          img.setAttribute("src", url);
        }
      } catch (e) { img.remove(); }
    }

    if (htmlDoc.body) {
      const frag = document.createDocumentFragment();
      for (const child of Array.from(htmlDoc.body.childNodes)) {
        frag.appendChild(document.importNode(child, true));
      }
      contentArea.appendChild(frag);
    }

    if (readerMode === "paged" && this._pageViewport) {
      this._pageEndSentinel = contentArea.createSpan({ cls: "bs-page-end" });
      const layoutMode = landing === "end" ? "end" : (landing === "ratio" ? "ratio" : "keep");
      window.requestAnimationFrame(() => {
        this.layoutPages(layoutMode);
        if (landing === "bookmark") this.saveReadingPosition(true);
      });
      if (typeof ResizeObserver !== "undefined") {
        this._resizeObserver = new ResizeObserver(() => this.layoutPages("ratio"));
        this._resizeObserver.observe(this._pageViewport);
      }
    } else {
      this._pageEndSentinel = null;
    }
  }

  async changeChapter(newIdx, landAt = "start") {
    if (newIdx < 0 || newIdx >= this.spine.length) return;
    this.currentChapter = newIdx;
    this.currentPage = 0;
    this.savedRatio = 0;
    await this.renderReader(landAt === "end" ? "end" : "keep");
    await this.saveReadingPosition(true);
  }

  async saveSelectionAsQuote() {
    const sel = window.getSelection()?.toString().trim();
    if (!sel) { new Notice("Highlight some text first!"); return; }
    const schema = this.plugin.settings.metadataSchema || "sv";
    const today = new Date().toISOString().slice(0, 10);
    const block = `\n> [!quote] Chapter ${this.currentChapter + 1}, p. ${this.currentPage + 1} (${today})\n${sel.split(/\r?\n/).map(l => `> ${l}`).join("\n")}\n`;
    const content = await this.app.vault.read(this.book.file);
    const defH = schema === "en" ? "## ✍️ Highlights & Quotes" : "## ✍️ Anteckningar & Citat";
    await this.app.vault.modify(this.book.file, insertUnderHeading(content, ["## ✍️ Anteckningar & Citat", "## ✍️ Highlights & Quotes"], defH, block));
    new Notice("Quote saved to book note!");
  }
}

module.exports = class ReadDeckPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_SHELF, (leaf) => new ReadDeckView(leaf, this));
    this.registerView(VIEW_TYPE_EPUB, (leaf) => new EpubReaderView(leaf, this));
    this.addSettingTab(new ReadDeckSettingTab(this.app, this));
    this.addRibbonIcon("book-open", "Open ReadDeck", () => this.activateShelfView());
    this.addCommand({ id: "open-library", name: "Open book library", callback: () => this.activateShelfView() });
  }
  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  buildBookNoteData(item, coverOverride = null) {
    const schema = this.settings.metadataSchema || "sv";
    const useSv = schema !== "en";
    const pm = parsePropertyMap(this.settings.propertyMapJson);
    const statusDefs = getAllDefs(BASE_STATUS_DEFS, this.settings.customStatuses);
    const formatDefs = getAllDefs(BASE_FORMAT_DEFS, this.settings.customFormats);
    const folderPath = (this.settings.booksFolder || "Books").replace(/^\/+|\/+$/g, "");
    const safeFileName = renderFilename(this.settings.filenameTemplate, item, "{{author}} - {{title}}");
    const filePath = `${folderPath}/${safeFileName}.md`;

    const today = new Date().toISOString().slice(0, 10);
    const safeTitle = String(item.title || "Untitled").replace(/"/g, '\\"');
    const authorVal = formatGraphValue(item.author || "Unknown Author", this.settings.linkAuthor).replace(/"/g, '\\"');
    const catVal = formatGraphValue(item.kategori || (useSv ? "Böcker" : "Books"), this.settings.linkCategory).replace(/"/g, '\\"');
    const fmtYaml = defKeyToYaml(item.formatKey || this.settings.defaultFormat || "ebook", schema, formatDefs);
    const statusKey = item.statusKey || this.settings.defaultStatus || "want";
    const statusYaml = defKeyToYaml(statusKey, schema, statusDefs);
    const ratingVal = item.rating !== undefined && item.rating !== "" ? item.rating : "";
    const startedVal = item.started || today;
    const finishedVal = item.finished || (statusKey === "completed" ? today : "");
    const coverVal = coverOverride !== null ? coverOverride : (item.saveCoverLocal && item.coverUrl ? `[[${safeFileName}.jpg]]` : (item.coverUrl || ""));
    const vaultFileLink = item.vaultFileName ? `[[${item.vaultFileName}]]` : "";
    const extPath = (item.fullPath || "").replace(/\\/g, "\\\\");

    const fmLines = [
      "---",
      `${pKey(pm, "type", useSv ? "typ" : "type")}: ${useSv ? "bok" : "book"}`,
      `${pKey(pm, "title", useSv ? "titel" : "title")}: "${safeTitle}"`,
      `${pKey(pm, "author", useSv ? "författare" : "author")}: "${authorVal}"`,
      `${pKey(pm, "format", "format")}: "${fmtYaml}"`,
      `${pKey(pm, "category", useSv ? "kategori" : "category")}: "${catVal}"`,
      `${pKey(pm, "status", "status")}: "${statusYaml}"`,
      `${pKey(pm, "rating", useSv ? "betyg" : "rating")}: ${ratingVal}`,
      ...(item.pages ? [`${pKey(pm, "pages", useSv ? "sidor" : "pages")}: ${item.pages}`] : []),
      ...(item.year ? [`${pKey(pm, "year", useSv ? "utgivningsår" : "published")}: ${item.year}`] : []),
      `${pKey(pm, "started", useSv ? "startad" : "started")}: "${startedVal}"`,
      `${pKey(pm, "finished", useSv ? "avslutad" : "finished")}: "${finishedVal}"`,
      `${pKey(pm, "reading_time_minutes", useSv ? "lästid_minuter" : "reading_time_minutes")}: 0`,
      `${pKey(pm, "progress", "progress")}: ${statusKey === "completed" ? 100 : 0}`,
      `${pKey(pm, "cover", useSv ? "omslag" : "cover")}: "${coverVal}"`,
      `${pKey(pm, "file", useSv ? "fil" : "file")}: "${vaultFileLink}"`,
      `${pKey(pm, "external_file", useSv ? "extern_fil" : "external_file")}: "${extPath}"`,
      "tags:",
      `  - ${useSv ? "media/bok" : "media/book"}`,
      "---"
    ];

    const logH = useSv ? "## 💡 Tankar & Läspass" : "## 💡 Reading Log & Notes";
    const qH = useSv ? "## ✍️ Anteckningar & Citat" : "## ✍️ Highlights & Quotes";
    const reviewLine = item.review ? `\n- **Imported review**: ${item.review}\n` : "";
    let body = "";
    if (this.settings.customNoteTemplate && this.settings.customNoteTemplate.trim()) {
      body = applyTemplateTokens(this.settings.customNoteTemplate, {
        title: item.title || "Untitled", author: item.author || "", cover: coverVal ? `![[${stripWikilink(coverVal)}]]` : "",
        year: item.year || "", pages: item.pages || "", category: item.kategori || "",
        log_heading: logH + reviewLine, quotes_heading: qH
      });
    } else {
      body = `# 📖 ${item.title || "Untitled"}\n\n${logH}${reviewLine}\n\n${qH}\n`;
    }
    return { folderPath, safeFileName, filePath, content: fmLines.join("\n") + "\n\n" + body };
  }

  async createBookNote(item, silent = false) {
    const pre = this.buildBookNoteData(item);
    await ensureVaultFolder(this.app, pre.folderPath);
    let file = this.app.vault.getAbstractFileByPath(pre.filePath);
    if (file) return { file, created: false };

    let finalCover = item.coverUrl || "";
    const wantLocal = item.saveCoverLocal !== undefined ? item.saveCoverLocal : this.settings.saveCoversLocally;
    if (finalCover && wantLocal && !silent && this.settings.onlineSearchEnabled !== false) {
      finalCover = await downloadCoverSafely(this.app, this.settings, finalCover, pre.safeFileName, "99 Obsidian/_Bilagor/Bokomslag");
    }
    const built = this.buildBookNoteData(item, finalCover);
    file = await this.app.vault.create(built.filePath, built.content);
    if (!silent) new Notice(`Added to ReadDeck: ${item.title}`);
    return { file, created: true };
  }

  async mirrorSessionToDailyNote(book, mins, noteText = "") {
    if (!this.settings.mirrorToDailyNote) return;
    try {
      const file = await findOrCreateTodayDailyNote(this.app, this.settings);
      if (this.settings.dailyNoteMirrorProperties !== false) {
        const minsKey = (this.settings.dailyNoteMinutesProp ?? "läsning_minuter").trim();
        const booksKey = (this.settings.dailyNoteBooksProp ?? "läsning").trim();
        const link = `[[${book.file.basename}]]`;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          if (minsKey && mins > 0) fm[minsKey] = Number(fm[minsKey] || 0) + mins;
          if (booksKey) {
            let arr = Array.isArray(fm[booksKey]) ? fm[booksKey] : (fm[booksKey] ? [fm[booksKey]] : []);
            if (!arr.includes(link)) arr.push(link);
            fm[booksKey] = arr;
          }
        });
      }
      if (this.settings.dailyNoteMirrorBody !== false) {
        const entry = `- 📖 [[${book.file.basename}]]${mins > 0 ? ` *(${mins} min)*` : ""}${noteText ? `: ${noteText}` : ""}`;
        const content = await this.app.vault.read(file);
        const h = (this.settings.dailyNoteHeading || "").trim();
        await this.app.vault.modify(file, h ? insertUnderHeading(content, [h], h, entry) : content.trimEnd() + `\n${entry}\n`);
      }
    } catch (e) { console.error("ReadDeck: Daily Note mirror error:", e); }
  }

  async importFromCsv(csvText) {
    const records = parseCsvText(csvText);
    if (!records.length) { new Notice("No valid book rows found in CSV."); return; }
    const statusDefs = getAllDefs(BASE_STATUS_DEFS, this.settings.customStatuses);
    const formatDefs = getAllDefs(BASE_FORMAT_DEFS, this.settings.customFormats);
    let created = 0, skipped = 0;
    new Notice(`Importing ${records.length} books...`);
    for (const r of records) {
      const title = r["title"]; if (!title) continue;
      const shelf = r["exclusive shelf"] || r["read status"] || "";
      const rn = parseFloat(r["my rating"] || r["star rating"] || "");
      const finished = normalizeCsvDate(r["date read"] || r["last date read"] || "");
      const res = await this.createBookNote({
        title, author: r["author"] || r["authors"] || "Unknown Author", kategori: "Imported",
        statusKey: shelf ? normalizeDefKey(shelf, statusDefs, "want") : (this.settings.defaultStatus || "want"),
        formatKey: (r["binding"] || r["format"]) ? normalizeDefKey(r["binding"] || r["format"], formatDefs, "ebook") : (this.settings.defaultFormat || "ebook"),
        rating: !isNaN(rn) && rn > 0 ? rn : "", started: normalizeCsvDate(r["date added"] || "") || finished, finished,
        pages: parseInt(r["number of pages"] || "", 10) || "", year: parseInt(r["original publication year"] || r["year published"] || "", 10) || "",
        review: (r["my review"] || r["review"] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        coverUrl: "", saveCoverLocal: false, fullPath: "", vaultFileName: ""
      }, true);
      if (res?.created) created++; else skipped++;
    }
    new Notice(`CSV Import complete: ${created} added, ${skipped} skipped.`);
  }

  async activateShelfView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SHELF);
    if (leaves.length > 0) { this.app.workspace.revealLeaf(leaves[0]); return; }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_SHELF, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  async openEpubReader(book) {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_EPUB, active: true });
    if (leaf.view instanceof EpubReaderView) await leaf.view.loadBook(book);
  }
};
