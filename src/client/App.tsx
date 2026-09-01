import {
  FormEvent,
  Fragment,
  ReactNode,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ChatMessage } from "../shared/protocol";
import { fetchConversation, fetchHealth, streamChat, type HealthStatus } from "./api";

const STORAGE_KEY = "sierra-outfitters-conversation";

type ChatPhase =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "streaming"; draft: string }>
  | Readonly<{ kind: "error"; message: string }>;

interface ChatState {
  readonly conversationId: string | null;
  readonly messages: readonly ChatMessage[];
  readonly pendingUserMessageId: string | null;
  readonly phase: ChatPhase;
}

type Action =
  | Readonly<{ type: "hydrate"; conversationId: string; messages: readonly ChatMessage[]; pendingUserMessageId: string | null }>
  | Readonly<{ type: "start" }>
  | Readonly<{ type: "accepted"; conversationId: string; message: ChatMessage }>
  | Readonly<{ type: "delta"; text: string }>
  | Readonly<{ type: "completed"; message: ChatMessage }>
  | Readonly<{ type: "failed"; message: string }>
  | Readonly<{ type: "reset" }>;

const initialState: ChatState = {
  conversationId: null,
  messages: [],
  pendingUserMessageId: null,
  phase: { kind: "idle" },
};

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "hydrate":
      return {
        conversationId: action.conversationId,
        messages: action.messages,
        pendingUserMessageId: action.pendingUserMessageId,
        phase: { kind: "idle" },
      };
    case "start":
      return { ...state, phase: { kind: "streaming", draft: "" } };
    case "accepted":
      return {
        ...state,
        conversationId: action.conversationId,
        messages: state.messages.some((message) => message.id === action.message.id)
          ? state.messages
          : [...state.messages, action.message],
        pendingUserMessageId: action.message.id,
      };
    case "delta":
      return state.phase.kind === "streaming"
        ? { ...state, phase: { kind: "streaming", draft: state.phase.draft + action.text } }
        : state;
    case "completed":
      return {
        ...state,
        messages: [...state.messages, action.message],
        pendingUserMessageId: null,
        phase: { kind: "idle" },
      };
    case "failed":
      return { ...state, phase: { kind: "error", message: action.message } };
    case "reset":
      return initialState;
  }
}

const starterPrompts = [
  "Recommend gear for a winter adventure",
  "Help me track an order",
  "I want to claim the Early Risers promotion",
];

function MountainMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M4 38 19 11l7 13 5-8 13 22H4Z" fill="currentColor" opacity=".96" />
      <path d="m14 20 5-9 4 8-4-2-5 3Zm12 4 5-8 4 7-4-2-5 3Z" fill="#f7f1df" />
    </svg>
  );
}

function safeText(text: string): ReactNode {
  const parts = text.split(/(https:\/\/[^\s]+)/g);
  return parts.map((part, index) => part.startsWith("https://")
    ? <a key={`${part}-${index}`} href={part} target="_blank" rel="noreferrer">Track with USPS</a>
    : <Fragment key={`${index}-${part.slice(0, 8)}`}>{part}</Fragment>);
}

function MessageBubble({ message }: { readonly message: ChatMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-label">{message.role === "user" ? "You" : "Sierra trail guide"}</div>
      <div className="message-body">{safeText(message.content)}</div>
    </article>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [input, setInput] = useState("");
  const [health, setHealth] = useState<HealthStatus>({ ok: false, mode: "offline" });
  const transcriptRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const busy = state.phase.kind === "streaming";

  useEffect(() => {
    void fetchHealth().then(setHealth);
    const storedId = localStorage.getItem(STORAGE_KEY);
    if (!storedId) return;
    void fetchConversation(storedId)
      .then((conversation) => {
        if (!conversation) {
          localStorage.removeItem(STORAGE_KEY);
          return;
        }
        dispatch({
          type: "hydrate",
          conversationId: conversation.id,
          messages: conversation.messages,
          pendingUserMessageId: conversation.pendingUserMessageId,
        });
      })
      .catch(() => dispatch({ type: "failed", message: "Your saved conversation could not be loaded." }));
  }, []);

  const draft = state.phase.kind === "streaming" ? state.phase.draft : "";
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && nearBottom.current) transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
  }, [state.messages, draft]);

  const statusLabel = useMemo(() => {
    if (!health.ok) return "Offline";
    if (health.mode === "unconfigured") return "API key needed";
    return "Trail guide online";
  }, [health]);

  const runStream = async (retry: boolean, message?: string) => {
    dispatch({ type: "start" });
    let body: Record<string, string>;
    if (retry) {
      body = { conversationId: state.conversationId ?? "" };
    } else if (state.conversationId) {
      body = { conversationId: state.conversationId, message: message ?? "" };
    } else {
      body = { message: message ?? "" };
    }
    const result = await streamChat(retry ? "/api/chat/retry" : "/api/chat", body, {
      onAccepted: (conversationId, userMessage) => {
        localStorage.setItem(STORAGE_KEY, conversationId);
        dispatch({ type: "accepted", conversationId, message: userMessage });
      },
      onDelta: (text) => dispatch({ type: "delta", text }),
      onCompleted: (assistantMessage) => dispatch({ type: "completed", message: assistantMessage }),
    });
    if (result.kind === "failed") dispatch({ type: "failed", message: result.message });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy || state.pendingUserMessageId) return;
    setInput("");
    void runStream(false, message);
  };

  const reset = () => {
    localStorage.removeItem(STORAGE_KEY);
    setInput("");
    dispatch({ type: "reset" });
  };

  return (
    <div className="page-shell">
      <header className="site-header">
        <div className="brand">
          <span className="brand-mark"><MountainMark /></span>
          <span><strong>Sierra Outfitters</strong><small>Trail guide</small></span>
        </div>
        <div className="header-actions">
          <span className={`connection ${health.ok ? "online" : ""}`}><i />{statusLabel}</span>
          <button className="ghost-button" type="button" onClick={reset}>New conversation</button>
        </div>
      </header>

      <main className="chat-card">
        <div
          className="transcript"
          ref={transcriptRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
          }}
          aria-live="polite"
        >
          {state.messages.length === 0 && !busy ? (
            <section className="welcome">
              <span className="eyebrow">Your next adventure starts here</span>
              <h1>How can we help you hit the trail?</h1>
              <p>Find the right gear, check an order, or catch an early-morning deal.</p>
              <div className="starter-grid">
                {starterPrompts.map((prompt, index) => (
                  <button key={prompt} type="button" onClick={() => setInput(prompt)}>
                    <span>{index === 0 ? "Gear" : index === 1 ? "Orders" : "Early Risers"}</span>
                    {prompt}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <div className="message-list">
            {state.messages.map((message) => <MessageBubble key={message.id} message={message} />)}
            {state.phase.kind === "streaming" ? (
              <article className="message assistant draft">
                <div className="message-label">Sierra trail guide</div>
                <div className="message-body">
                  {draft ? safeText(draft) : <span className="thinking">Checking the trail map<span>...</span></span>}
                  <span className="cursor" aria-hidden="true" />
                </div>
              </article>
            ) : null}
          </div>
        </div>

        {state.phase.kind === "error" ? (
          <div className="notice error"><span>{state.phase.message}</span></div>
        ) : null}

        {state.pendingUserMessageId && !busy ? (
          <div className="notice retry">
            <span>Your message is saved, but the reply did not finish.</span>
            <button type="button" onClick={() => void runStream(true)}>Retry reply</button>
          </div>
        ) : null}

        <form className="composer" onSubmit={submit}>
          <label htmlFor="message-input" className="sr-only">Message Sierra Outfitters</label>
          <textarea
            id="message-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={state.pendingUserMessageId ? "Retry the saved message before sending another" : "Ask about gear, an order, or Early Risers"}
            rows={1}
            disabled={busy || Boolean(state.pendingUserMessageId)}
          />
          <button className="send-button" type="submit" disabled={busy || !input.trim() || Boolean(state.pendingUserMessageId)} aria-label="Send message">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 17 8-17 8 3-8-3-8Zm3.8 7h7.4L6.6 7l1.2 4Zm-1.2 6 8.6-4H7.8l-1.2 4Z" /></svg>
          </button>
        </form>
        <p className="composer-note">AI can make mistakes. Order and product facts come from Sierra's local records.</p>
      </main>
    </div>
  );
}
