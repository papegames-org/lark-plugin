"""Compatibility shim — `approval_auth` IS `core.auth`.

Alias the module object itself so any access via `approval_auth.X` resolves
to the same attribute as `core.auth.X`, including private symbols and
test-time `mock.patch.object(approval_auth, "X", ...)` calls.
"""

from __future__ import annotations

import sys
from core import auth as _impl

sys.modules[__name__] = _impl
