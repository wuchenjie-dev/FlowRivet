import type { ConfirmationChallenge } from "../../contracts/executions.js";

export function GuardedActionDialog(props: { challenge: ConfirmationChallenge; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <div className="guarded-action" role="alertdialog" aria-modal="true" aria-labelledby="guarded-action-title">
    <h3 id="guarded-action-title">{props.challenge.summary.title}</h3>
    <ul>{props.challenge.summary.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
    <p>此确认仅本次有效，五分钟后失效。</p>
    <div><button type="button" onClick={props.onCancel}>取消</button><button type="button" disabled={props.pending} onClick={props.onConfirm}>{props.challenge.summary.title}</button></div>
  </div>;
}
