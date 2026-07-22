export type DocChunk = {
  path: string;
  content: string;
  patient: string;
  sourceFile: string;
  kind: 'markdown' | 'xml-section' | 'xml-overview';
};

export type VolumeFs = {
  list: (directoryPath?: string) => Promise<
    Array<{ path?: string; name?: string; is_directory?: boolean }>
  >;
  read: (filePath: string, options?: { maxSize?: number }) => Promise<string>;
  upload?: (filePath: string, contents: string, options?: { overwrite?: boolean }) => Promise<void>;
  createDirectory?: (directoryPath: string) => Promise<void>;
};

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/th>/gi, ' | ')
      .replace(/<\/td>/gi, ' | ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

/** Extract balanced XML elements by local name (namespace-prefix aware). */
function extractElements(xml: string, localName: string): string[] {
  const openRe = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b[^>]*>`, 'gi');
  const closeRe = new RegExp(`</(?:[\\w.-]+:)?${localName}\\s*>`, 'gi');
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(xml)) !== null) {
    const start = match.index;
    const afterOpen = openRe.lastIndex;
    if (match[0].endsWith('/>')) {
      results.push(match[0]);
      continue;
    }
    let depth = 1;
    closeRe.lastIndex = afterOpen;
    openRe.lastIndex = afterOpen;
    let end = -1;
    while (depth > 0) {
      const nextOpen = openRe.exec(xml);
      const nextClose = closeRe.exec(xml);
      if (!nextClose) break;
      if (nextOpen && nextOpen.index < nextClose.index) {
        if (!nextOpen[0].endsWith('/>')) depth += 1;
        closeRe.lastIndex = openRe.lastIndex;
      } else {
        depth -= 1;
        end = nextClose.index + nextClose[0].length;
        openRe.lastIndex = closeRe.lastIndex;
        if (depth === 0) break;
      }
    }
    if (end > start) {
      results.push(xml.slice(start, end));
      openRe.lastIndex = end;
    }
  }
  return results;
}

function firstElementInner(xml: string, localName: string): string | null {
  const els = extractElements(xml, localName);
  if (!els.length) return null;
  return els[0].replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '');
}

function allTextContents(xml: string, localName: string): string[] {
  return extractElements(xml, localName).map((el) => stripTags(el)).filter(Boolean);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown_patient';
}

function patientFromFilename(fileName: string): string | null {
  const base = fileName.replace(/\.xml$/i, '').replace(/\s*\(\d+\)\s*$/, '');
  const cleaned = base.replace(/[_-]+/g, ' ').replace(/\d{6,}/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  // james_testpatient → James Testpatient
  return cleaned
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function normalizePatientKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function patientAliases(name: string): string[] {
  const raw = name.trim();
  const key = normalizePatientKey(raw);
  const parts = raw.toLowerCase().split(/[^a-z0-9]+/).filter((p) => p.length >= 3);
  const aliases = new Set<string>([raw.toLowerCase(), key, ...parts]);
  // Common compact forms: EmmaTestPatient, JamesTestPatient
  if (parts.length >= 2) aliases.add(parts.join(''));
  return [...aliases].filter((a) => a.length >= 3);
}

export function inferPatientFromMarkdown(path: string, content: string): string {
  const lower = `${path}\n${content}`.toLowerCase();
  if (lower.includes('emmatestpatient') || /\bemma\b/.test(lower)) return 'EmmaTestPatient';
  if (lower.includes('jamestestpatient') || /\bjames\b/.test(lower)) return 'James Test Patient';
  const nameMatch = content.match(/Name:\s*([^\n\r]+)/i);
  if (nameMatch?.[1]) return nameMatch[1].trim();
  return 'Unknown patient';
}

export function parseCcdaXml(xml: string, sourcePath: string): DocChunk[] {
  const fileName = sourcePath.split('/').pop() ?? sourcePath;
  const patientRole = extractElements(xml, 'patientRole')[0] ?? '';
  const patientBlock = extractElements(patientRole || xml, 'patient')[0] ?? '';
  const givens = allTextContents(patientBlock, 'given');
  const families = allTextContents(patientBlock, 'family');
  const nameFromXml = [...givens, ...families].join(' ').replace(/\s+/g, ' ').trim();
  const docTitle = stripTags(firstElementInner(xml, 'title') ?? '') || fileName;
  const fromFile = patientFromFilename(fileName);
  // Filename is usually clearer than CDA name-part order (e.g. "Test Patient James")
  const patient =
    fromFile ||
    nameFromXml ||
    docTitle.replace(/:.*/, '').replace(/health summary/i, '').trim() ||
    'Unknown patient';

  const genderEl = extractElements(patientBlock, 'administrativeGenderCode')[0] ?? '';
  const genderCode = genderEl.match(/\bcode="([^"]+)"/i)?.[1];
  const genderDisplay = genderEl.match(/\bdisplayName="([^"]+)"/i)?.[1] ?? genderCode;
  const birth = extractElements(patientBlock, 'birthTime')[0]?.match(/\bvalue="([^"]+)"/i)?.[1];

  const overviewLines = [
    `# ${docTitle}`,
    '',
    `Source file: ${sourcePath}`,
    '',
    '## Patient demographics',
    `- Name: ${patient}`,
    genderDisplay ? `- Gender: ${genderDisplay}` : null,
    birth ? `- Date of birth: ${birth}` : null,
    '',
    '## Available clinical sections',
  ].filter((line): line is string => line !== null);

  const sectionChunks: DocChunk[] = [];
  const sections = extractElements(xml, 'section');
  const seenTitles = new Set<string>();

  for (const section of sections) {
    const title = stripTags(firstElementInner(section, 'title') ?? '') || 'Untitled section';
    // Prefer narrative <text>; skip nested duplicate titles
    const titleKey = title.toLowerCase();
    if (seenTitles.has(titleKey)) continue;
    const narrative = firstElementInner(section, 'text');
    const body = narrative ? stripTags(narrative) : stripTags(section).slice(0, 8000);
    if (!body || body.length < 8) continue;
    seenTitles.add(titleKey);
    overviewLines.push(`- ${title}`);

    const content = [
      `# ${title}`,
      '',
      `Patient: ${patient}`,
      `Source file: ${sourcePath}`,
      '',
      body,
    ].join('\n');

    sectionChunks.push({
      path: `${sourcePath}#${slugify(title)}`,
      content,
      patient,
      sourceFile: sourcePath,
      kind: 'xml-section',
    });
  }

  const overview: DocChunk = {
    path: `${sourcePath}#overview`,
    content: overviewLines.join('\n'),
    patient,
    sourceFile: sourcePath,
    kind: 'xml-overview',
  };

  return [overview, ...sectionChunks];
}

async function listFilesRecursive(
  fs: VolumeFs,
  directoryPath = '',
): Promise<Array<{ path: string; name: string }>> {
  const out: Array<{ path: string; name: string }> = [];
  let entries: Array<{ path?: string; name?: string; is_directory?: boolean }> = [];
  try {
    entries = await fs.list(directoryPath || undefined);
  } catch (err) {
    console.warn(`Could not list ${directoryPath || '(root)'}:`, err);
    return out;
  }

  for (const entry of entries) {
    const name = entry.name ?? '';
    const path = entry.path ?? (directoryPath ? `${directoryPath}/${name}` : name);
    if (!path) continue;
    if (entry.is_directory) {
      // Skip our own generated cache if present to avoid recursion loops on huge trees
      if (name === '.git') continue;
      out.push(...(await listFilesRecursive(fs, path)));
    } else {
      out.push({ path, name: name || path });
    }
  }
  return out;
}

export async function loadAllCcdaDocs(fs: VolumeFs): Promise<{
  docs: DocChunk[];
  patients: string[];
  xmlFiles: string[];
  markdownFiles: string[];
}> {
  const files = await listFilesRecursive(fs);
  const docs: DocChunk[] = [];
  const xmlFiles: string[] = [];
  const markdownFiles: string[] = [];

  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (lower.endsWith('.xml')) {
      xmlFiles.push(file.path);
      try {
        const xml = await fs.read(file.path, { maxSize: 5_000_000 });
        docs.push(...parseCcdaXml(xml, file.path));
      } catch (err) {
        console.warn(`Failed to parse C-CDA XML ${file.path}:`, err);
      }
      continue;
    }

    if (lower.endsWith('.md')) {
      markdownFiles.push(file.path);
      try {
        const content = (await fs.read(file.path, { maxSize: 2_000_000 })).trim();
        if (!content) continue;
        docs.push({
          path: file.path,
          content,
          patient: inferPatientFromMarkdown(file.path, content),
          sourceFile: file.path,
          kind: 'markdown',
        });
      } catch (err) {
        console.warn(`Skipping unreadable file ${file.path}:`, err);
      }
    }
  }

  const byPath = new Map(docs.map((d) => [d.path, d]));
  const unique = [...byPath.values()];
  const patients = [...new Set(unique.map((d) => d.patient))].sort((a, b) =>
    a.localeCompare(b),
  );

  return { docs: unique, patients, xmlFiles, markdownFiles };
}

export function detectMentionedPatients(question: string, patients: string[]): string[] {
  const q = question.toLowerCase();
  const matched: string[] = [];
  for (const patient of patients) {
    const aliases = patientAliases(patient);
    // Prefer longer aliases first to reduce false positives
    const hit = aliases
      .sort((a, b) => b.length - a.length)
      .some((alias) => {
        if (alias.length >= 5) return q.includes(alias);
        // Short tokens like "emma" / "james" — whole-word style
        return new RegExp(`\\b${alias}\\b`, 'i').test(question);
      });
    if (hit) matched.push(patient);
  }
  return matched;
}

export function buildContext(
  docs: DocChunk[],
  question: string,
  patients: string[],
): { context: string; sources: string[]; matchedPatients: string[] } {
  const q = question.toLowerCase();
  const matchedPatients = detectMentionedPatients(question, patients);
  const pool =
    matchedPatients.length > 0
      ? docs.filter((d) => matchedPatients.includes(d.patient))
      : docs;

  const scored = pool
    .map((d) => {
      const hay = `${d.path}\n${d.patient}\n${d.content}`.toLowerCase();
      let score = 0;
      for (const token of q.split(/[^a-z0-9]+/).filter((t) => t.length > 3)) {
        if (hay.includes(token)) score += 1;
      }
      if (d.kind === 'xml-overview' || d.path.includes('overview') || d.path.includes('summary')) {
        score += 0.5;
      }
      if (matchedPatients.includes(d.patient)) score += 3;
      return { ...d, score };
    })
    .sort((a, b) => b.score - a.score);

  const selected = (
    scored.some((d) => d.score >= 1) ? scored.filter((d) => d.score >= 1) : scored
  ).slice(0, 10);

  const patientNote =
    matchedPatients.length > 0
      ? `Focus patients for this question: ${matchedPatients.join(', ')}.`
      : patients.length > 0
        ? `Available patients in knowledge base: ${patients.join(', ')}. If the user named a patient, prefer that patient's documents.`
        : '';

  const context = [patientNote, ...selected.map((d) => `### Source: ${d.path}\nPatient: ${d.patient}\n${d.content}`)]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 28000);

  return {
    context,
    sources: selected.map((d) => d.path),
    matchedPatients,
  };
}
