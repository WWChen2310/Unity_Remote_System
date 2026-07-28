# Nine-Seat Split Mode and MadMapper Area Controls

## Goal

Update the remote-control system so split-content mode controls nine seats in
the same order used by Unity, and replace the two legacy MadMapper surface
groups with six independently controlled areas:

- `Main`
- `T1`
- `T2`
- `T3`
- `T4`
- `Ground`

MadMapper OSC addresses remain owned by the Node.js server. Unity receives
content and seat state through WebSocket and does not send OSC.

## Seat State

`tableModes` is a nine-element integer array. Seat numbering and array indexes
have a direct mapping:

| UI label | WebSocket index | Unity region index |
| --- | ---: | ---: |
| Seat 1 | 0 | 0 |
| Seat 2 | 1 | 1 |
| Seat 3 | 2 | 2 |
| Seat 4 | 3 | 3 |
| Seat 5 | 4 | 4 |
| Seat 6 | 5 | 5 |
| Seat 7 | 6 | 6 |
| Seat 8 | 7 | 7 |
| Seat 9 | 8 | 8 |

The web console renders nine controls and sends the displayed seat index
without reversing it. The server accepts indexes 0 through 8. Entering split
mode resets all nine values to `0`.

When an existing eight-seat state file is loaded, the first eight values are
preserved and a ninth value of `0` is appended. Longer arrays are truncated to
nine elements. Missing or invalid entries use `0`, so the server always
broadcasts a valid nine-element array.

Unity stores nine values, accepts a nine-element update, and applies each value
to the matching `RegionManager` index. No index reversal or translation occurs.
The actual Unity project file and the controller copy in this repository remain
in sync.

## MadMapper Configuration

Add `madmapper.config.json` at the Node.js server root. It contains connection
settings and the six area definitions. Each area has a stable WebSocket-facing
name and a complete user-editable OSC address.

Example structure:

```json
{
  "ip": "192.168.0.202",
  "port": 8010,
  "localPort": 9000,
  "areas": [
    {
      "name": "Main",
      "oscAddress": "/surfaces/Main/opacity"
    }
  ]
}
```

The remaining five entries follow the same structure for `T1`, `T2`, `T3`,
`T4`, and `Ground`. Addresses are sent exactly as configured; the server does
not build an address from the area name.

At startup, the server validates that area names are unique and that every OSC
address is a non-empty string beginning with `/`. Invalid configuration stops
startup with an actionable error instead of sending OSC to an unintended
address.

## Web and Server Data Flow

The web console has one area-control card containing six switches. A switch
sends:

```json
{
  "type": "madmapperControl",
  "surface": "Main",
  "enabled": true
}
```

The server validates `surface` against the configured area map, stores its
boolean state, looks up the configured OSC address, and sends one float argument:

- enabled: `1.0`
- disabled: `0.0`

Unknown area names are rejected and do not alter state or emit OSC.

Legacy grouped names such as `Main-1` and `Main-2` are not copied into the new
state. The six new areas start disabled unless a matching valid area state
already exists. Mask selection no longer enables one surface group while
disabling another; mask state and the six area switches are independent.

## Files in Scope

- `interface/console.html`
  - Render nine direct-index seat controls.
  - Render one six-area control panel.
  - Remove mode-1/mode-2 surface-group behavior.
- `integrated-server.js`
  - Load validated MadMapper configuration.
  - Normalize persisted seat and area state.
  - Accept seat indexes 0 through 8.
  - Resolve exact OSC addresses from configuration.
- `madmapper.config.json`
  - Expose MadMapper network and area OSC settings.
- `system_state.json`
  - Migrate the checked-in example state to nine seats and six area keys while
    preserving the user's current seat values.
- `UnityModeController.cs`
  - Keep the repository copy aligned with the nine-seat direct mapping.
- `D:/Repositories/Unity/Room/Assets/Script/Singleton/UnityModeController.cs`
  - Update the actual Unity project controller to nine-seat direct mapping.
- `Readme.md`
  - Document the MadMapper configuration and Unity Inspector steps.

No OSC package or OSC sender is added to Unity.

## Testing and Verification

Node tests use the built-in `node:test` runner and cover:

- eight persisted seat values migrate to nine with a trailing `0`;
- invalid or oversized seat data normalizes to exactly nine values;
- seat indexes 0 and 8 are accepted while out-of-range indexes are rejected;
- only the six configured area names are accepted;
- each area resolves to its exact configured OSC address;
- invalid or duplicate area configuration is rejected.

The implementation follows red-green-refactor: each behavioral test is observed
failing before production code is added.

Verification includes:

- complete Node test suite;
- JavaScript syntax checks for server and extracted modules;
- fresh Unity batch-mode compilation of `D:/Repositories/Unity/Room`;
- repository diff review confirming the existing custom server IP is preserved;
- a requirements checklist covering nine direct-index seats, six independent
  areas, editable OSC addresses, and Unity setup documentation.

