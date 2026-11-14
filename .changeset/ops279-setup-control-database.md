---
"@vibase/server-d1": patch
---

`vibase-server setup` creates, records and migrates the instance's control-plane D1 database `vb-control-<env>` (recorded as `control_d1` in the settings file; `--control-d1-name` overrides it, a name that differs from the record is refused with exit 2), migrates it before the CRM database, and writes the control marker after the CRM deployment row, including for an instance bootstrapped before. An instance recorded without a control database gets one on its next run.
