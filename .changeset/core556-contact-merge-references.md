---
'@vibase/server-d1': minor
---

`contacts.merge` fills the survivor's custom (`__c`) fields from the source after tombstoning it, so a unique value the source held can move, and answers the survivor's record plus `merge_conflicts` (`[{ field, source_value }]` for every field where both contacts held different values; `[]` when none). A custom object's field, or an extension field on companies, deals and tasks, may reference `contacts` (`target: "contacts"`), and merge re-points those references to the survivor. An extension field on contacts cannot reference contacts (`reference_contacts_self`). The merge response schema gains `merge_conflicts`; no migration.
