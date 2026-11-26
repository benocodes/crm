---
'@vibase/server-d1': minor
'@vibase/cli': minor
---

On the built-in sign-in, a CLI login and an agent account now follow their live permissions. A person's `vibase login` holds their role as it is at each request, so a permission added later (a new custom object, a new scope) works with the same login and no sign-in again; an agent account holds what its record says at each request, so an owner's grant or removal applies on its next request. `vibase login --scope a,b` is now a limited login: it sends the provider scope `limited_login` with the list and holds only those scopes, including for permissions added later. A login without `--scope` is unchanged on the wire. `limited_login` is a provider scope (listed in `scopes_supported`, never a vault scope or a default). The device page says a full login grants everything the person's role allows, including later permissions, and lists the scopes of a limited one. `agents.create` and `agents.update` accept any custom scope the workspace declares, whatever scopes the caller holds. Older logins made with `--scope` carry no marker and become full logins until the person signs in with `--scope` again.
