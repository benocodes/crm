---
'@vibase/server-d1': minor
---

Contacts, companies, deals and tasks carry an `additional_props` bag: a flat object of extra facts (string, number or boolean values, lowercase snake_case keys, at most 50 keys and 8 KiB) that agents read, merge-patch (`null` removes a key) and propose under the record's own scopes. Migration `0026_additional_props` adds the column to the four tables (existing rows get `{}`), so run `vibase-server upgrade` to apply it. The bag rides in the record's `created` and `updated` events, and a contact merge fills the survivor's missing keys.
