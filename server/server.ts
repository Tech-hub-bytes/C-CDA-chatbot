import { createApp, files, server, serving } from '@databricks/appkit';
import { z } from 'zod';
import { buildContext, loadAllCcdaDocs, type DocChunk } from './ccda.js';

const SYSTEM_PROMPT = `You are a clinical document assistant for HL7 C-CDA health summaries.
Multiple patients may be present in the knowledge base.
Answer ONLY using the provided document context for the patient(s) relevant to the question.
If the user names a patient, use that patient's documents only.
Cite the section name when possible (Allergies, Medications, Problems, Vitals, etc.).
If the answer is not in the context, say you do not know and list which patients are available if helpful.
Do not invent clinical facts.
Remind the user this is synthetic demo data when relevant.
Keep answers concise and clear.`;

function normalizeContent(content: unknown): string | null {
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  return null;
}

function extractAssistantText(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '');

  const maybeResult = result as { ok?: boolean; data?: unknown; message?: string };
  if (maybeResult.ok === true && maybeResult.data !== undefined) {
    return extractAssistantText(maybeResult.data);
  }
  if (maybeResult.ok === false) {
    return maybeResult.message ?? 'Model invocation failed';
  }

  const r = result as {
    choices?: Array<{ message?: { content?: unknown }; text?: string }>;
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
    message?: { content?: unknown };
    content?: unknown;
  };

  const fromChoices = normalizeContent(r.choices?.[0]?.message?.content);
  if (fromChoices) return fromChoices;
  if (typeof r.choices?.[0]?.text === 'string' && r.choices[0].text.trim()) {
    return r.choices[0].text;
  }

  const fromMessage = normalizeContent(r.message?.content);
  if (fromMessage) return fromMessage;

  const fromContent = normalizeContent(r.content);
  if (fromContent) return fromContent;

  if (typeof r.output_text === 'string' && r.output_text.trim()) return r.output_text;
  if (Array.isArray(r.output)) {
    const texts: string[] = [];
    for (const item of r.output) {
      for (const c of item.content ?? []) {
        if (c.text) texts.push(c.text);
      }
    }
    if (texts.length) return texts.join('\n');
  }
  return 'Unable to parse model response.';
}

createApp({
  plugins: [
    files({
      volumes: {
        files: { policy: files.policy.allowAll() },
      },
    }),
    server(),
    serving(),
  ],
  async onPluginsReady(appkit) {
    let cachedDocs: DocChunk[] = [];
    let cachedPatients: string[] = [];
    let cachedXmlFiles: string[] = [];
    let lastLoadError: string | null = null;
    let lastFingerprint = '';
    let refreshInFlight: Promise<void> | null = null;

    const fingerprint = (xmlFiles: string[], markdownFiles: string[]) =>
      [...xmlFiles, ...markdownFiles].sort().join('|');

    const refreshDocs = async (force = false) => {
      if (refreshInFlight) {
        await refreshInFlight;
        if (!force) return;
      }

      refreshInFlight = (async () => {
        try {
          const loaded = await loadAllCcdaDocs(appkit.files('files'));
          const nextFp = fingerprint(loaded.xmlFiles, loaded.markdownFiles);
          if (!force && nextFp === lastFingerprint && cachedDocs.length > 0) {
            return;
          }
          cachedDocs = loaded.docs;
          cachedPatients = loaded.patients;
          cachedXmlFiles = loaded.xmlFiles;
          lastFingerprint = nextFp;
          lastLoadError =
            cachedDocs.length === 0
              ? 'No C-CDA markdown or XML documents found in volume.'
              : null;
          console.log(
            `Loaded ${cachedDocs.length} chunks for ${cachedPatients.length} patient(s); xml=${loaded.xmlFiles.length} md=${loaded.markdownFiles.length}`,
          );
        } catch (err) {
          lastLoadError = err instanceof Error ? err.message : String(err);
          console.error('Failed to load C-CDA docs:', err);
        } finally {
          refreshInFlight = null;
        }
      })();

      await refreshInFlight;
    };

    await refreshDocs(true);

    // Periodically pick up new uploads even if the user stays on Chat
    setInterval(() => {
      void refreshDocs(false);
    }, 20_000);

    appkit.server.extend((app) => {
      app.get('/api/whoami', (req, res) => {
        const email = req.header('x-forwarded-email') ?? req.header('x-forwarded-user') ?? 'local-dev-user';
        res.json({
          user: email,
          executionNote:
            'Upload C-CDA XML or markdown in Documents. New files are indexed automatically for chat.',
        });
      });

      app.get('/api/ccda/status', async (_req, res) => {
        await refreshDocs(false);
        res.json({
          docsLoaded: cachedDocs.length,
          patients: cachedPatients,
          xmlFiles: cachedXmlFiles,
          sources: cachedDocs.map((d) => d.path),
          error: lastLoadError,
        });
      });

      app.post('/api/ccda/refresh', async (_req, res) => {
        await refreshDocs(true);
        res.json({
          docsLoaded: cachedDocs.length,
          patients: cachedPatients,
          xmlFiles: cachedXmlFiles,
          error: lastLoadError,
        });
      });

      app.post('/api/ccda/chat', async (req, res) => {
        const parsed = z
          .object({
            message: z.string().min(1).max(4000),
            history: z
              .array(
                z.object({
                  role: z.enum(['user', 'assistant']),
                  content: z.string(),
                }),
              )
              .max(20)
              .optional(),
          })
          .safeParse(req.body);

        if (!parsed.success) {
          res.status(400).json({ error: 'Invalid request. Provide { message: string }.' });
          return;
        }

        // Always re-scan so newly uploaded CCDAs are available immediately
        await refreshDocs(true);

        if (cachedDocs.length === 0) {
          res.status(503).json({
            error: lastLoadError ?? 'C-CDA documents are not available yet.',
          });
          return;
        }

        const { message, history = [] } = parsed.data;
        const { context, sources, matchedPatients } = buildContext(
          cachedDocs,
          message,
          cachedPatients,
        );

        const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
          ...history.slice(-6),
          {
            role: 'user',
            content: `${SYSTEM_PROMPT}\n\nDocument context:\n\n${context}\n\n---\nUser question: ${message}`,
          },
        ];

        const invokeOnce = async (obo: boolean) => {
          const result = obo
            ? await appkit.serving().asUser(req).invoke({ messages })
            : await appkit.serving().invoke({ messages });

          if (result && typeof result === 'object' && 'ok' in result) {
            const er = result as { ok: boolean; data?: unknown; status?: number; message?: string };
            if (!er.ok) {
              const err = new Error(er.message ?? 'Model invocation failed') as Error & {
                statusCode?: number;
              };
              err.statusCode = er.status;
              throw err;
            }
            return extractAssistantText(er.data);
          }

          return extractAssistantText(result);
        };

        try {
          const answer = await invokeOnce(true);
          res.json({
            answer,
            sources,
            matchedPatients,
            patients: cachedPatients,
            disclaimer:
              'AI-generated from C-CDA demo documents — verify before any clinical use. Synthetic data only.',
          });
        } catch (err) {
          try {
            const answer = await invokeOnce(false);
            res.json({
              answer,
              sources,
              matchedPatients,
              patients: cachedPatients,
              disclaimer:
                'AI-generated from C-CDA demo documents — verify before any clinical use. Synthetic data only.',
            });
          } catch (err2) {
            console.error('Chat invoke failed:', err, err2);
            const status =
              err2 && typeof err2 === 'object' && 'statusCode' in err2
                ? Number((err2 as { statusCode?: number }).statusCode) || 500
                : 500;
            res.status(status).json({
              error: err2 instanceof Error ? err2.message : 'Model invocation failed',
            });
          }
        }
      });
    });
  },
}).catch(console.error);
