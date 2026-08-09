# Licensing

OpenEMT is available under two licences. You choose which one applies to you.

## 1. Open source: GNU AGPL v3 (default)

OpenEMT is free software under the **GNU Affero General Public License,
version 3 only** (`AGPL-3.0-only`). The full text is in [LICENSE](LICENSE).

Use it, study it, modify it, and share it. In return the AGPL asks that if you
distribute OpenEMT or a modified version, you pass the same freedoms on, under
the same licence, with source.

**The clause most people need to know about is section 13.** The AGPL differs
from the ordinary GPL in one way that matters here: if you run a modified
OpenEMT as a network service, and users interact with it over that network,
you must offer those users the source of your modified version. Running it
privately, inside your own organisation, triggers nothing. Publishing a
modified version as a hosted tool does.

If that works for you, you are done. There is nothing to sign and nobody to
contact.

## 2. Commercial licence

If the AGPL does not work for your situation, a commercial licence is
available from **PEN LLC**, which removes the copyleft and section 13
obligations under negotiated terms.

The usual reasons people need one:

- You want to embed OpenEMT in a proprietary product you distribute.
- You want to offer a hosted service built on a modified OpenEMT without
  publishing your modifications.
- Your organisation has a policy against AGPL-licensed software.
- You need warranty, indemnity, support, or liability terms that an open
  source licence does not provide. (The AGPL explicitly provides none: see
  sections 15 and 16.)

**To enquire: licensing@openemt.pro**

Terms are agreed per engagement. Tell us what you are building and how you
intend to deploy it, and we will tell you quickly whether you need a
commercial licence at all. Often the answer is no.

## Why dual licensing

Because both audiences are real. Students, researchers, and engineers who want
a free EMT simulator should not have to ask anyone's permission, and the AGPL
guarantees that permanently. Companies building commercial products on top of
it should contribute back, either in source under the AGPL or commercially.
The dual licence lets both happen without either subsidising the other.

## Contributing

Contributions are welcome, and there is one requirement worth stating up
front: contributors sign a **Contributor Licence Agreement** ([CLA.md](CLA.md))
before their first contribution is merged.

This is not bureaucracy for its own sake. Offering a commercial licence
requires the licensor to hold the necessary rights to all of the code. Without
a CLA, a single merged patch would make it impossible to grant a commercial
licence covering that file, and equally impossible to ever move the project to
a different licence. Retroactive CLA collection does not work: it requires
tracking down every past contributor individually, and a single unreachable
one is permanent.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest of the process.

## Trademark

The licences above cover copyright. They do not grant rights in the OpenEMT
name. See [TRADEMARK.md](TRADEMARK.md).

## Copyright

Copyright (C) 2026 Hiva Nasiri.

Every source file carries an `SPDX-License-Identifier: AGPL-3.0-only` tag, and
the built `index.html` carries the notice too, since it is frequently saved and
passed around detached from this repository.
