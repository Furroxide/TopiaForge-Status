# TURN transport review

The shared transport preserves the control-plane live check's long-term TURN credential derivation. When no different password algorithm is negotiated, STUN specifies a sixteen-byte MD5 key derived from the username, realm and credential: [RFC 8489 section 9.2.2](https://www.rfc-editor.org/rfc/rfc8489.html#section-9.2.2).

CodeQL flags this inherited operation as a high-severity weak-cryptography alert when the transport is extracted into its new source file in TopiaForge PR #394. The alert remains open; neither the scanner nor its merge gate is disabled or suppressed. Independent review is required before commissioning that change.

The monitor uses only freshly minted TURN credentials with the service's existing short lifetime and rate/spend limits. It does not hash human passwords for storage, reuse application login credentials, or persist the derived key. The protocol compatibility check reproduces the published long-term-authentication MESSAGE-INTEGRITY result from [RFC 5769 section 2.4](https://www.rfc-editor.org/rfc/rfc5769.html#section-2.4). Changing MD5 to SHA-256 without negotiating the corresponding STUN password algorithm would change the protocol and can break allocation; any modernization needs its own compatibility evidence.
