---
name: gotcha_doctl_format_flag_masks_creation_success
description: doctl compute droplet create --wait with an invalid --format column name fails on the PRINT step AFTER the droplet was already created and waited-on — the create silently succeeds and gets orphaned since its ID never reaches you; a naive retry then creates a duplicate droplet.
metadata:
  type: reference
---

`doctl compute droplet create coldstart-engine ... --wait --format
ID,Name,PublicIPv4,Status,Region,Size` failed with `Error: unknown column
"Size"` (the correct column name is `SizeSlug`). This looked like a clean
create failure, so the natural move was to fix the flag and re-run — but the
underlying droplet creation + `--wait` polling had already completed before
doctl tried (and failed) to render the requested columns. The retry created
a SECOND droplet; the account ended up with two `coldstart-engine` droplets
~51 seconds apart, only one of which had ever been surfaced by a
successful print.

**Why:** `--format` validation/rendering in doctl happens as the last step,
after the API call and `--wait` polling, not before. An invalid format
string does not prevent the resource from being created — it only prevents
you from seeing the result.

**How to apply:** before retrying ANY `doctl ... create --wait` command that
failed, run `doctl compute droplet list` (or the equivalent list command for
the resource type) FIRST to check whether a resource with the intended name
already exists, especially if the error looks like an output-formatting
issue rather than an API rejection (`unknown column`, parse errors) rather
than an auth/validation error (`4xx`, `invalid size`, etc.). If a duplicate
did get created, delete the orphan immediately rather than leaving it —
don't let "which one is real" linger past the same session.
