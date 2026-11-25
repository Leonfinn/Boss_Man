import type { BoardTicket } from "../api";

// BOS-2578: several tickets can wait on ONE decision card. The owner counts cards (the Decisions badge),
// so the board says "questions" and "tasks" separately and tells each sharing ticket who it shares with.

type Waiter = Pick<BoardTicket, "id" | "title" | "number" | "ownerQuestionId">;

/** The distinct owner asks behind these tickets: tickets on one card count once; one with no card counts alone. */
export function askCount(waiting: Waiter[]): number {
  return new Set(waiting.map((t) => t.ownerQuestionId ?? t.id)).size;
}

export function asksWords(waiting: Waiter[]): string {
  const cards = askCount(waiting);
  const tasks = waiting.length;
  if (cards === tasks) return tasks === 1 ? "1 task is waiting on you." : `${tasks} tasks are waiting on you.`;
  return `${cards === 1 ? "1 question is" : `${cards} questions are`} waiting on you, holding ${tasks} tasks.`;
}

/** The other waiting tickets that share this ticket's decision card. */
export function sameQuestionAs<T extends Waiter>(t: Waiter, waiting: T[]): T[] {
  if (!t.ownerQuestionId) return [];
  return waiting.filter((w) => w.id !== t.id && w.ownerQuestionId === t.ownerQuestionId);
}

const NUMBER_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

export function sameQuestionText(others: Array<{ number?: number | null; title: string }>, ref: (n: number) => string): string {
  const names = others.map((o) => (o.number ? ref(o.number) : o.title));
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const all = others.length + 1;
  return `Same question as ${list}: one answer releases ${all === 2 ? "both" : `all ${NUMBER_WORDS[all] ?? all}`}.`;
}

export function OwnerAsksStrip({ waiting }: { waiting: Waiter[] }) {
  return (
    <a className="strip" href="#your-review" onClick={(e) => { e.preventDefault(); document.getElementById("your-review")?.scrollIntoView?.({ behavior: "smooth", inline: "center" }); }}>
      <span>
        <span className="count-badge">{askCount(waiting)}</span>
        <span>
          <strong data-testid="owner-asks-words">{asksWords(waiting)}</strong> {waiting[0]!.title}
        </span>
      </span>
      <strong style={{ whiteSpace: "nowrap" }}>Review it <span aria-hidden="true">→</span></strong>
    </a>
  );
}

export function OwnerAsksLaneHead({ waiting }: { waiting: Waiter[] }) {
  const cards = askCount(waiting);
  return (
    <header className="lane-head">
      <div className="lane-title">
        <h2 id="lane-your-review">Your review</h2>
        <span className="count-badge">{cards}</span>
      </div>
      {cards !== waiting.length && (
        <span className="lane-hint" data-testid="owner-asks-lane-hint">
          {cards === 1 ? "1 question" : `${cards} questions`} hold{cards === 1 ? "s" : ""} {waiting.length} tasks. One answer releases every task on the same question.
        </span>
      )}
    </header>
  );
}

export function SameQuestionLine({ text }: { text: string }) {
  return (
    <span className="note" data-testid="same-question-note">
      {text}
    </span>
  );
}
