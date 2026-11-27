import type { Company } from "../api";
import { AddToShortcuts } from "../pinned-pages";
import { OpenIssues } from "../components/OpenIssues";
import { ScrumMasterLog } from "../components/ScrumMasterLog";
import { WatchdogHealth } from "../components/WatchdogHealth";

/** Everything the Scrum Master and the watchdog did, newest first, with the reason for each and an undo. */
export function ScrumMaster({ company }: { company: Company | undefined }) {
  if (!company) return <p className="muted">Pick a company first.</p>;
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">{company.name}</p>
          <h1>Scrum Master log</h1>
          <AddToShortcuts page="scrum-master" />
          <p className="sub">What the watchdog caught and what the Scrum Master did about it. Switch it on or tune it in <a href={`#/settings/${company.id}/watchdog`}>Settings → Watchdog</a>.</p>
        </div>
        <WatchdogHealth companyId={company.id} />
      </header>
      <OpenIssues companyId={company.id} />
      <ScrumMasterLog companyId={company.id} filterable summary />
    </>
  );
}
