import type { RunnerCommand } from "@boss-man/shared";
import type { CommandSender, runnersService } from "../../src/services/runners.js";

type Hub = Pick<ReturnType<typeof runnersService>, "connect" | "resolveReply">;
export type StandInReplies = Partial<Record<RunnerCommand["type"], unknown>>;

/**
 * Plays a company's runner in a test (BOS-663). It answers the requests named in `replies` and refuses
 * every other request at once with an error naming the command, so a reply the test lacks fails in
 * milliseconds instead of waiting out the request's timeout (an unanswered workspace.diff cost each
 * after-merge-criteria merge test 60 s). Each refused command type is kept in the returned list, so a test
 * can show it was asked nothing unexpected. One-way commands (no requestId, or a permission verdict, whose
 * requestId names the runner's own request) expect no reply and are just accepted.
 */
export function standInRunner(hub: Hub, runnerId: string, replies: StandInReplies): string[] {
  const refused: string[] = [];
  const send: CommandSender = (command) => {
    const requestId = (command as { requestId?: string }).requestId;
    if (requestId === undefined || command.type === "permission.decide") return true;
    const known = Object.hasOwn(replies, command.type);
    if (!known) refused.push(command.type);
    queueMicrotask(() =>
      hub.resolveReply(known ? { requestId, ok: true, data: replies[command.type] } : { requestId, ok: false, error: `The test's stand-in runner has no reply for ${command.type}.` }),
    );
    return true;
  };
  hub.connect(runnerId, send);
  return refused;
}
