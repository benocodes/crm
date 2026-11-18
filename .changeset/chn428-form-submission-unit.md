---
'@vibase/server-d1': minor
---

The form submission capture unit (dormant, no route yet): given a form and a submission's fields, the vault picks the submitter (email, else phone), checks the workspace blocklist, stores the content and records one inbound `form` interaction on the submitter's contact as the form's principal, with every event. An existing contact is only added to (a null name is filled, the form's tags are linked). No behaviour change until the public form route ships.
