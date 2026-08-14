# Meegle created-item fixtures

`created-query-page.json` is a synthetic, redacted fixture matching the observed
first-page `moql_field_list` response shape. It proves only the initial page
contract. Created-item session pagination stays disabled until a real response
with more than 50 results has been captured and redacted.

`created-query-empty.json` is a redacted fixture of an observed no-match
response. The empty response has `data: {}` and `list: null`; it is distinct
from a non-empty grouped response.

`project-search-page.json` and `meta-types.json` are redacted captures of the
observed project catalog and work-item type metadata shapes. `is_disable: 2`
is intentionally retained because it is returned for active types and is not
treated as a boolean disabled flag.
