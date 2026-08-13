# Meegle write probe fixtures

No real write-probe fixture has been captured yet.

Only add fixtures produced from an explicitly confirmed isolated test work item.
Before committing, replace every business identifier and retain only response
shape, primitive types, pagination behavior, and stable error codes. Remove
titles, descriptions, comments, field values, people, email addresses, tokens,
request payloads, and raw command output.

Candidate manifests are probe output for human review. They must not replace
`src/writeback/meegle-write-capabilities.json` until write, read-back, repeated
same-value write, and restoration all succeed for each enabled capability.

Meegle CLI 1.0.19 exposes comment `list` and `add --action create|update`, but
no comment delete command. A successful isolated probe therefore leaves one
redacted `FLOWRIVET_WRITE_PROBE` marker comment on the test work item. Comment
capability requires full-page list, create/read-back, update/read-back, and a
repeated identical update/read-back. If creation succeeds but any later comment
stage fails, the result sets `manual_cleanup_required=true`. A thrown runner,
nonzero/timeout-equivalent exit, or invalid JSON after invoking comment create
is also an uncertain remote outcome: search only for the fixed
`FLOWRIVET_WRITE_PROBE` marker on the isolated work item and clean up manually.
Probe output never includes the nonce or comment body in cleanup guidance.
