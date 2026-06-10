import type { ReportData } from '../game/events';
import { ordinal, usd } from './chips';

/** End-of-run panel — a race result or a wreckage report, by report kind. */
export function ReportPanel({ report }: { report: ReportData }) {
  return (
    <div className="panel">
      <div className="h">{report.kind === 'race' ? 'RACE RESULT' : 'WRECKAGE REPORT'}</div>
      <div className="val">{report.kind === 'race' ? `${ordinal(report.position)} PLACE` : usd(report.total)}</div>
      <div className="sub">
        {report.kind === 'race'
          ? `${report.wrecked} ${report.wrecked === 1 ? 'RIVAL' : 'RIVALS'} WRECKED`
          : `${report.wrecked} ${report.wrecked === 1 ? 'VEHICLE' : 'VEHICLES'} WRECKED`}
      </div>
      <div className={`medal ${report.medal.toLowerCase()}`}>
        {report.medal === 'NONE' ? 'NO MEDAL' : `${report.medal} MEDAL`}
      </div>
      <div className="key">R — RUN IT BACK</div>
    </div>
  );
}
