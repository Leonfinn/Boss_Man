// The "Thinking" trace shown above an agent reply (BOS-1368, design BOS-1367): a closed one-line
// summary ("Thought for 42 s · 6 steps"), which opens to the steps in order, each one sentence with
// an icon for its kind, and each step opens to its detail. One component for every agent's chat: the
// CEO's and each worker's, because they all render through pages/Chat.tsx. The words, kinds and caps
// come from @boss-man/shared/thinking, the same code the server records with.
import { useId, useState, type ReactNode } from "react";
import { TRACE_KIND_WORD, traceHeadline, traceTime, type TraceBody, type TraceKind, type TraceStep } from "@boss-man/shared";

type Props = {
  trace: TraceBody;
  /** This is the run still working, so the header shows "Thinking · N s · Step k" and the loader. */
  live?: boolean;
  /** What the running step is doing now, for the live header ("Searching tickets"). */
  liveStep?: string;
  /** Open or closed overrides from the page, keyed by run, so a live trace stays open when its reply lands. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** The steps opened by index, kept by the page so a poll doesn't close them. */
  stepOpen?: Record<number, boolean>;
  onStepToggle?: (index: number, open: boolean) => void;
};

const iconProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

// One shape per kind (never colour alone): a light bulb, a magnifier, a pencil, a terminal, a warning.
const THINK = <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5V16h8v-2.5A6 6 0 0 0 12 3z" />;
const LOOK = (
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </>
);
const DO = <path d="M4 20h4L19 9l-4-4L4 16z" />;
const RUN = (
  <>
    <path d="M5 7l4 5-4 5" />
    <path d="M12 17h7" />
  </>
);
const FAIL = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </>
);
// The done lead: the live loader's three bars, still and grey.
const LEAD = (
  <>
    <rect x="4" y="9" width="4" height="6" rx="1" />
    <rect x="10" y="6" width="4" height="12" rx="1" />
    <rect x="16" y="10" width="4" height="4" rx="1" />
  </>
);

function iconFor(kind: TraceKind, flag?: TraceStep["flag"]): ReactNode {
  if (flag === "failed") return FAIL;
  if (flag === "refused") return FAIL;
  if (kind === "reasoning") return THINK;
  if (kind === "look") return LOOK;
  if (kind === "command") return RUN;
  if (kind === "action") return DO;
  return LOOK;
}

const TINT: Record<TraceKind, string> = {
  reasoning: "k-think",
  look: "k-look",
  action: "k-do",
  command: "k-run",
  other: "k-look",
};

/** The header words for the live state: "Thinking · 12 s · Step 3: Searching tickets". */
function liveHeadline(trace: TraceBody, what?: string): string {
  const secs = trace.secs;
  const step = trace.steps.length;
  const doing = what ?? (trace.steps.at(-1)?.summary ?? "Thinking");
  return `Thinking · ${secs} s · Step ${step}: ${doing}`;
}

/** Show more / show less for a long detail: clips at ~6 lines and says so with a button. */
function Detail({ text, isCut, long }: { text: string; isCut?: boolean; long?: boolean }) {
  const [all, setAll] = useState(false);
  const canClip = long && text.length > 280;
  return (
    <>
      <pre className={canClip && !all ? "clip" : undefined}>{text}</pre>
      {canClip && (
        <button type="button" className="more" onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : "Show more"}
        </button>
      )}
      {isCut && <span className="cut">Cut short: only the start of what the agent saw was kept.</span>}
    </>
  );
}

export function ThinkingTrace({ trace, live = false, liveStep, open, onToggle, stepOpen = {}, onStepToggle }: Props) {
  const uid = useId();
  const [selfOpen, setSelfOpen] = useState(false);
  const isOpen = open ?? selfOpen;
  const toggle = (v: boolean) => (onToggle ? onToggle(v) : setSelfOpen(v));
  const stopped = !!trace.stopped;
  const head = live ? liveHeadline(trace, liveStep) : traceHeadline(trace);
  // No steps and not live: no trace at all (design: a short reply with no steps shows nothing).
  if (!live && !trace.steps.length && !trace.dropped) return null;
  const stepsId = `${uid}-steps`;
  const many = trace.steps.length > 12;

  return (
    <div className={`trace${live ? " live" : ""}${stopped ? " stopped" : ""}`} data-live={live ? "yes" : "no"}>
      <button type="button" className={`trace-head${stopped ? " stopped" : ""}`} aria-expanded={isOpen} aria-controls={stepsId} onClick={() => toggle(!isOpen)} aria-label={head}>
        <svg className={`lead${live ? " spin" : ""}`} width={16} height={16} {...iconProps}>
          {stopped ? FAIL : LEAD}
        </svg>
        <span className="words">{head}</span>
        <svg className="chev" width={14} height={14} {...iconProps}>
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {isOpen && (
        <ul className="trace-steps" id={stepsId}>
          {trace.steps.map((s, i) => (
            <StepRow
              key={i}
              step={s}
              index={i}
              running={live && i === trace.steps.length - 1}
              open={stepOpen[i]}
              onToggle={onStepToggle}
            />
          ))}
          {!!trace.dropped && (
            <li className="gone">
              …and {trace.dropped} more step{trace.dropped === 1 ? "" : "s"}
            </li>
          )}
          {many && <li className="muted">Older steps were trimmed to keep this reply small.</li>}
        </ul>
      )}
    </div>
  );
}

function StepRow({ step, index, running, open, onToggle }: { step: TraceStep; index: number; running: boolean; open?: boolean; onToggle?: (i: number, open: boolean) => void }) {
  const [selfOpen, setSelfOpen] = useState(false);
  const isOpen = open ?? selfOpen;
  const set = (v: boolean) => (onToggle ? onToggle(index, v) : setSelfOpen(v));
  const hasDetail = !!(step.input || step.output);
  const kind = step.flag ? TINT[step.kind] : running ? "k-live" : TINT[step.kind];
  const flagWord = step.flag === "failed" ? "Failed" : step.flag === "refused" ? "Not allowed" : null;
  return (
    <li>
      <button
        type="button"
        className={`step-row ${kind}${hasDetail ? "" : " plain"}`}
        {...(hasDetail ? { "aria-expanded": isOpen, "aria-controls": `step-${index}` } : {})}
        onClick={hasDetail ? () => set(!isOpen) : undefined}
        disabled={!hasDetail}
      >
        <svg className="ico" width={16} height={16} {...iconProps}>
          {running ? LEAD : iconFor(step.kind, step.flag)}
        </svg>
        <span className="sum">
          <span className="visually-hidden">{running ? "Running now: " : `${TRACE_KIND_WORD[step.kind]}: `}</span>
          {step.flag === "failed" && <span className="visually-hidden">Failed: </span>}
          {step.summary}
        </span>
        {flagWord && <span className={`step-flag${step.flag === "refused" ? " no" : ""}`}>{flagWord}</span>}
        {!flagWord && <span />}
        <span className="time">{running ? "now" : step.ms != null ? traceTime(step.ms) : ""}</span>
        <svg className="chev" width={14} height={14} {...iconProps}>
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {hasDetail && isOpen && (
        <div className="step-detail" id={`step-${index}`}>
          {step.input && (
            <div>
              {step.labels && <span className="label">{step.labels.input}</span>}
              {step.kind === "reasoning" ? <div className="reason">{step.input}</div> : <Detail text={step.input} isCut={step.cut} />}
            </div>
          )}
          {step.output && (
            <div>
              <span className="label">{step.labels?.output ?? "Got back"}</span>
              {step.output.trim() ? <Detail text={step.output} isCut={step.cut} long /> : <em className="cut">(nothing came back)</em>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
