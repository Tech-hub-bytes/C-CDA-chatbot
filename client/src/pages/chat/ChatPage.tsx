import { useEffect, useState } from 'react';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
  Textarea,
} from '@databricks/appkit-ui/react';

type ChatRole = 'user' | 'assistant';

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  sources?: string[];
  disclaimer?: string;
}

interface StatusResponse {
  docsLoaded: number;
  patients?: string[];
  xmlFiles?: string[];
  sources: string[];
  error: string | null;
}

interface WhoAmI {
  user: string;
  executionNote: string;
}

export function ChatPage() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  useEffect(() => {
    void Promise.all([
      fetch('/api/ccda/status').then(async (r) => {
        if (!r.ok) throw new Error(`Status ${r.status}`);
        return r.json() as Promise<StatusResponse>;
      }),
      fetch('/api/whoami').then(async (r) => {
        if (!r.ok) throw new Error(`Whoami ${r.status}`);
        return r.json() as Promise<WhoAmI>;
      }),
    ])
      .then(([s, w]) => {
        setStatus(s);
        setWhoami(w);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load chat status');
      })
      .finally(() => setStatusLoading(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const question = input.trim();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: question,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const history = messages.slice(-6).map(({ role, content }) => ({ role, content }));
      const response = await fetch('/api/ccda/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question, history }),
      });
      const data = (await response.json()) as {
        answer?: string;
        sources?: string[];
        disclaimer?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.answer ?? '',
          sources: data.sources,
          disclaimer: data.disclaimer,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chat request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-bold text-foreground">C-CDA Patient Chat</h2>
          {whoami?.user ? <Badge variant="secondary">{whoami.user}</Badge> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Ask questions about any uploaded HL7 C-CDA health summary (allergies, meds, problems,
          vitals, care plan). Name the patient (e.g. Emma or James). Synthetic demo data only.
        </p>
        {whoami?.executionNote ? (
          <p className="text-xs text-muted-foreground">{whoami.executionNote}</p>
        ) : null}
      </div>

      {statusLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : status?.error ? (
        <Alert variant="destructive">
          <AlertDescription>{status.error}</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-base">
              Knowledge loaded: {status?.docsLoaded ?? 0} sections
              {status?.patients && status.patients.length > 0
                ? ` · ${status.patients.length} patient${status.patients.length === 1 ? '' : 's'}`
                : ''}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs text-muted-foreground">
            <div>
              Source volume: <code>/Volumes/workspace/default/ccda_chatbot_docs</code>
            </div>
            {status?.patients && status.patients.length > 0 ? (
              <div>
                Patients:{' '}
                {status.patients.map((p) => (
                  <Badge key={p} variant="outline" className="mr-1">
                    {p}
                  </Badge>
                ))}
              </div>
            ) : null}
            {(status?.xmlFiles?.length ?? 0) > 0 ? (
              <div>Indexed XML C-CDAs: {status?.xmlFiles?.length}</div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <div className="flex h-[min(640px,70vh)] flex-col rounded-lg border">
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 && !loading ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Ask about the C-CDA document</EmptyTitle>
                <EmptyDescription>
                  Try: &quot;What medications is James on?&quot; or &quot;List Emma&apos;s
                  allergies.&quot; Upload new C-CDA XML files in Documents.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-4 py-2 ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground'
                }`}
              >
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</p>
                {msg.sources && msg.sources.length > 0 ? (
                  <div className="mt-2 border-t border-border/40 pt-2 text-xs opacity-80">
                    <p className="font-medium">Sources</p>
                    <ul className="list-disc pl-4">
                      {msg.sources.map((s) => {
                        const label = s.split('/').pop() ?? s;
                        return (
                          <li key={s} title={s}>
                            {label}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
                {msg.disclaimer ? (
                  <p className="mt-2 text-xs opacity-70">{msg.disclaimer}</p>
                ) : null}
              </div>
            </div>
          ))}

          {loading ? (
            <div className="flex justify-start">
              <div className="rounded-lg bg-muted px-4 py-2 text-sm text-muted-foreground">
                Thinking…
              </div>
            </div>
          ) : null}

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t p-4">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question about the C-CDA health summary…"
            disabled={loading || (status?.docsLoaded ?? 0) === 0}
            rows={3}
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={loading || !input.trim() || (status?.docsLoaded ?? 0) === 0}>
              {loading ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
