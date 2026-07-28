# Nine-Seat Split Mode and MadMapper Areas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver nine directly indexed split-mode seats and one six-area MadMapper control panel whose OSC destinations are editable in a Node.js JSON configuration file.

**Architecture:** Pure CommonJS helpers will own seat normalization, area-state normalization, configuration validation, and OSC-message construction so these behaviors can be tested without starting network listeners. The existing Web console and WebSocket server will consume those helpers, while Unity will normalize and apply nine seat values with an identity seat-to-region mapping.

**Tech Stack:** Node.js 18.1+, built-in `node:test` and `assert`, WebSocket (`ws`), OSC (`osc`), browser JavaScript, Unity 6/C#, NativeWebSocket, Unity Test Framework.

---

## File Structure

- Create `control-model.js`: pure constants and functions for nine-seat state, six-area state, MadMapper configuration, and OSC payload construction.
- Create `madmapper.config.json`: user-editable MadMapper network settings and six exact OSC addresses.
- Create `test/control-model.test.js`: Node behavioral tests for state migration, validation, indexes, and OSC resolution.
- Create `interface/control-settings.js`: browser/CommonJS helper that supplies nine direct-index seats and the six area names.
- Create `test/control-settings.test.js`: Node tests for browser-facing seat and area descriptors.
- Modify `package.json`: add the built-in Node test command.
- Modify `integrated-server.js`: consume validated config/model helpers and reject invalid seat or area commands.
- Modify `interface/console.html`: load the browser helper, render nine seats in direct order, and render one six-area card.
- Modify `system_state.json`: store nine current seat values and only six new area keys.
- Modify `UnityModeController.cs`: align the repository copy to nine direct-index seats.
- Modify `D:/Repositories/Unity/Room/Assets/Script/Singleton/UnityModeController.cs`: align the actual Unity runtime controller.
- Create `D:/Repositories/Unity/Room/Assets/Tests/EditMode/UnityModeControllerSeatMappingTests.cs`: verify Unity normalization and direct region mapping.
- Modify `Readme.md`: document Node OSC configuration and Unity nine-region setup.

### Task 1: Node Control Model

**Files:**
- Create: `test/control-model.test.js`
- Create: `control-model.js`
- Modify: `package.json`

- [ ] **Step 1: Add a Node test script and write failing model tests**

Add `"test": "node --test"` under `scripts` in `package.json`. Create tests that import:

```js
const {
    SEAT_COUNT,
    normalizeTableModes,
    isValidTableIndex,
    validateMadmapperConfig,
    normalizeSurfaceStates,
    createMadmapperOscMessage
} = require('../control-model');
```

Cover these exact assertions:

```js
test('migrates eight seats by appending a default ninth seat', () => {
    assert.deepEqual(normalizeTableModes([3, 2, 1, 0, 3, 2, 1, 0]),
        [3, 2, 1, 0, 3, 2, 1, 0, 0]);
});

test('normalizes invalid and oversized seat state to nine values', () => {
    assert.equal(SEAT_COUNT, 9);
    assert.deepEqual(normalizeTableModes([0, 1, 2, 3, -1, 4, '2', null, 3, 1]),
        [0, 1, 2, 3, 0, 0, 0, 0, 3]);
});

test('accepts only direct seat indexes zero through eight', () => {
    assert.equal(isValidTableIndex(0), true);
    assert.equal(isValidTableIndex(8), true);
    assert.equal(isValidTableIndex(-1), false);
    assert.equal(isValidTableIndex(9), false);
});
```

Use a six-area fixture and assert that valid state keys survive, legacy keys are removed, exact OSC addresses are returned, duplicate names fail, and an address without a leading slash fails.

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npm test -- test/control-model.test.js`

Expected: FAIL with `Cannot find module '../control-model'`.

- [ ] **Step 3: Implement the minimal pure model**

Create `control-model.js` with:

```js
const SEAT_COUNT = 9;
const VALID_TABLE_MODES = new Set([0, 1, 2, 3]);

function normalizeTableModes(value) {
    const source = Array.isArray(value) ? value : [];
    return Array.from({ length: SEAT_COUNT }, (_, index) =>
        VALID_TABLE_MODES.has(source[index]) ? source[index] : 0);
}

function isValidTableIndex(value) {
    return Number.isInteger(value) && value >= 0 && value < SEAT_COUNT;
}
```

Implement `validateMadmapperConfig` to require a non-empty IP, integer ports from 1 to 65535, exactly the names `Main`, `T1`, `T2`, `T3`, `T4`, and `Ground` once each, and slash-prefixed addresses. Return a normalized config with an `areaMap`.

Implement:

```js
function normalizeSurfaceStates(value, areaMap) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(
        [...areaMap.keys()].map(name => [name, source[name] === true]));
}

function createMadmapperOscMessage(areaMap, surface, enabled) {
    const area = areaMap.get(surface);
    if (!area) return null;
    return {
        address: area.oscAddress,
        args: [{ type: 'f', value: enabled ? 1.0 : 0.0 }]
    };
}
```

Export all tested functions and constants.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `npm test -- test/control-model.test.js`

Expected: all control-model tests pass with zero failures.

- [ ] **Step 5: Commit the model**

Stage only `package.json`, `control-model.js`, and `test/control-model.test.js`, then commit:

```text
feat: add nine-seat and MadMapper control model
```

### Task 2: User-Editable MadMapper Configuration and Server Integration

**Files:**
- Create: `madmapper.config.json`
- Modify: `integrated-server.js`
- Create: `test/madmapper-config.test.js`

- [ ] **Step 1: Add a failing test for the deployment configuration**

Load `madmapper.config.json`, validate it with `validateMadmapperConfig`, and
assert that its configured name/address pairs are exactly:

```js
const expected = new Map([
    ['Main', '/surfaces/Main/opacity'],
    ['T1', '/surfaces/T1/opacity'],
    ['T2', '/surfaces/T2/opacity'],
    ['T3', '/surfaces/T3/opacity'],
    ['T4', '/surfaces/T4/opacity'],
    ['Ground', '/surfaces/Ground/opacity']
]);

for (const [name, oscAddress] of expected) {
    assert.equal(config.areaMap.get(name).oscAddress, oscAddress);
}
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- test/madmapper-config.test.js`

Expected: FAIL with `ENOENT` because `madmapper.config.json` does not exist.

- [ ] **Step 3: Add the configuration file**

Create `madmapper.config.json` with IP `192.168.0.202`, port `8010`, local port `9000`, and the six names/addresses listed in Step 1. This is the deployment-time file the user edits.

- [ ] **Step 4: Integrate the model with the server**

At startup, require and validate `madmapper.config.json`. Replace `OSC_CONFIG` and `SURFACES_SETTINGS` with the validated config and `areaMap`. Initialize and load state through `normalizeSurfaceStates`, and load `tableModes` through `normalizeTableModes`.

For `switchMode` mode 8, assign `normalizeTableModes([])`. For `updateTableMode`, require `isValidTableIndex(data.tableIndex)` and a mode in `0..3`.

For `madmapperControl`, call `createMadmapperOscMessage`. If it returns `null`, log a warning and neither save nor broadcast. Otherwise coerce `enabled` to a boolean, update state, send the returned OSC message, and broadcast the accepted state.

- [ ] **Step 5: Run tests and syntax validation**

Run:

```text
npm test
node --check control-model.js
node --check integrated-server.js
```

Expected: all tests pass and both syntax checks exit 0.

- [ ] **Step 6: Commit server configuration**

Stage only `madmapper.config.json`, `integrated-server.js`, and
`test/madmapper-config.test.js`, then commit:

```text
feat: configure six MadMapper OSC areas
```

### Task 3: Nine-Seat and Six-Area Web Console

**Files:**
- Create: `interface/control-settings.js`
- Create: `test/control-settings.test.js`
- Modify: `interface/console.html`

- [ ] **Step 1: Write failing browser-settings tests**

Create a CommonJS test that imports `createSeatSettings` and `AREA_NAMES`. Assert:

```js
assert.deepEqual(createSeatSettings().map(seat => seat.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8]);
assert.deepEqual(createSeatSettings().map(seat => seat.label),
    ['座位 1', '座位 2', '座位 3', '座位 4', '座位 5',
     '座位 6', '座位 7', '座位 8', '座位 9']);
assert.deepEqual(AREA_NAMES, ['Main', 'T1', 'T2', 'T3', 'T4', 'Ground']);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- test/control-settings.test.js`

Expected: FAIL with `Cannot find module '../interface/control-settings'`.

- [ ] **Step 3: Implement the browser/CommonJS settings helper**

Create an IIFE that exports this API through `module.exports` in Node and `window.ControlSettings` in a browser:

```js
const SEAT_COUNT = 9;
const AREA_NAMES = Object.freeze(['Main', 'T1', 'T2', 'T3', 'T4', 'Ground']);
const createSeatSettings = () =>
    Array.from({ length: SEAT_COUNT }, (_, index) => ({
        index,
        label: `座位 ${index + 1}`
    }));
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `npm test -- test/control-settings.test.js`

Expected: all browser-settings tests pass.

- [ ] **Step 5: Update the console**

Load `control-settings.js` before the inline script. Replace the two surface arrays with one list created from `AREA_NAMES`. Render one `surfaceGrid` and one pair of enable-all/disable-all actions.

Render seats with:

```js
const container = document.getElementById('tableControlPanel');
container.innerHTML = '';
ControlSettings.createSeatSettings().forEach(({ index, label }) => {
    const div = document.createElement('div');
    div.className = 'table-control-item';
    div.innerHTML = `
        <label class="table-control-label">${label}</label>
        <div class="table-btn-group" id="table-group-${index}">
            <button class="table-btn" onclick="updateTableMode(${index}, 0)" data-val="0">預設</button>
            <button class="table-btn" onclick="updateTableMode(${index}, 1)" data-val="1">海洋</button>
            <button class="table-btn" onclick="updateTableMode(${index}, 2)" data-val="2">森林</button>
            <button class="table-btn" onclick="updateTableMode(${index}, 3)" data-val="3">液態食物</button>
        </div>`;
    container.appendChild(div);
});
```

Delete the `7-i` reversal, the second surface card, grouped mask-to-surface toggling, and mode-specific bulk-toggle arguments. Preserve the user's current `const serverUrl = '10.0.1.251'`.

- [ ] **Step 6: Run all Node tests**

Run: `npm test`

Expected: all model and console-settings tests pass with zero failures.

- [ ] **Step 7: Commit the Web console**

Stage `interface/control-settings.js` and `test/control-settings.test.js`. Use
interactive staging for `interface/console.html`, selecting the seat/area
changes and explicitly leaving the pre-existing `serverUrl` hunk unstaged.
Then commit:

```text
feat: show nine seats and six area controls
```

### Task 4: Unity Nine-Seat Direct Mapping

**Files:**
- Create: `D:/Repositories/Unity/Room/Assets/Tests/EditMode/UnityModeControllerSeatMappingTests.cs`
- Modify: `D:/Repositories/Unity/Room/Assets/Script/Singleton/UnityModeController.cs`
- Modify: `UnityModeController.cs`

- [ ] **Step 1: Write failing Unity EditMode tests**

Add NUnit tests that assert:

```csharp
[Test]
public void NormalizeTableModes_AppendsDefaultNinthSeat()
{
    CollectionAssert.AreEqual(
        new[] { 3, 2, 1, 0, 3, 2, 1, 0, 0 },
        UnityModeController.NormalizeTableModes(
            new[] { 3, 2, 1, 0, 3, 2, 1, 0 }));
}

[TestCase(0, 0)]
[TestCase(8, 8)]
public void RegionIndexForSeat_UsesDirectOrder(int seatIndex, int expected)
{
    Assert.AreEqual(expected,
        UnityModeController.RegionIndexForSeat(seatIndex));
}
```

- [ ] **Step 2: Run Unity tests and confirm RED**

Run Unity 6.0.70f1 in batch mode against `D:/Repositories/Unity/Room`, EditMode, filtered to `UnityModeControllerSeatMappingTests`.

Expected: compilation failure because the two public static methods do not exist.

- [ ] **Step 3: Implement minimal Unity mapping behavior**

In both controller copies, add `SeatCount = 9`, initialize `currentTableModes` with that count, and implement:

```csharp
public static int[] NormalizeTableModes(int[] values)
{
    var result = new int[SeatCount];
    if (values != null)
        Array.Copy(values, result, Mathf.Min(values.Length, SeatCount));
    return result;
}

public static int RegionIndexForSeat(int seatIndex) => seatIndex;
```

Use normalization whenever table data arrives. Loop from `0` through
`SeatCount - 1` and pass `RegionIndexForSeat(i)` to all three `RegionManager`
methods.

- [ ] **Step 4: Run the Unity tests and confirm GREEN**

Run the same filtered Unity command.

Expected: both mapping tests pass with zero failures.

- [ ] **Step 5: Run a full Unity compile check**

Run Unity 6.0.70f1 in batch mode with `-quit` and no test filter against `D:/Repositories/Unity/Room`.

Expected: exit 0 and no C# compiler errors in the generated log.

- [ ] **Step 6: Commit Unity runtime and tests**

Stage only the actual Unity controller, its test and generated `.meta` file, plus the repository controller copy. Commit:

```text
feat: apply nine Unity seats in direct order
```

### Task 5: Persisted Example State and Operator Documentation

**Files:**
- Modify: `system_state.json`
- Modify: `Readme.md`

- [ ] **Step 1: Migrate the checked-in state carefully**

Replace legacy surface keys with `Main`, `T1`, `T2`, `T3`, `T4`, and `Ground`.
Retain the user's current eight `tableModes` values (`3`) and append a ninth
default value of `0`; do not alter the timestamp or unrelated auto-cycle
settings.

- [ ] **Step 2: Document deployment settings**

Add a readable section covering:

- edit `madmapper.config.json`;
- set MadMapper IP, input port, local OSC port, and each complete OSC address;
- restart the Node process after configuration changes;
- add/configure the ninth Unity region in `RegionManager`;
- confirm Unity indexes are `0..8` in the same order as seats `1..9`;
- assign ninth-seat material and VFX references wherever `RegionManager`
  serializes those arrays;
- Unity does not require an OSC package because Node sends OSC.

- [ ] **Step 3: Run configuration and JSON checks**

Run:

```text
node -e "JSON.parse(require('fs').readFileSync('madmapper.config.json','utf8')); JSON.parse(require('fs').readFileSync('system_state.json','utf8'))"
npm test
```

Expected: JSON parsing exits 0 and every Node test passes.

- [ ] **Step 4: Commit state and documentation**

Stage only `system_state.json` and `Readme.md`, then commit:

```text
docs: explain nine-seat and MadMapper setup
```

### Task 6: Final Verification and Review

**Files:**
- Review all files listed above.

- [ ] **Step 1: Run fresh Node verification**

Run:

```text
npm test
node --check integrated-server.js
node --check control-model.js
node --check interface/control-settings.js
```

Expected: zero test failures and all syntax checks exit 0.

- [ ] **Step 2: Run fresh Unity verification**

Run the filtered Unity EditMode test command and the full Unity batch-mode
compile command from Task 4.

Expected: zero filtered-test failures and no compiler errors.

- [ ] **Step 3: Review requirements and working-tree boundaries**

Confirm from the final diff:

- nine Web controls use indexes `0..8`;
- the server always stores/broadcasts nine seat values;
- Unity always applies nine values directly to indexes `0..8`;
- only six independent area switches remain;
- all OSC addresses come from `madmapper.config.json`;
- unknown area commands emit no OSC;
- `10.0.1.251` remains unchanged in the user's console edit;
- unrelated `.vexp` and other user changes are not staged or modified.

- [ ] **Step 4: Request code review**

Use the required code-review agent for the completed JavaScript and C# changes.
Resolve any confirmed high- or medium-priority issue, rerun the affected tests,
and retain evidence in the final handoff.

- [ ] **Step 5: Report the operator handoff**

Provide links to the config, Unity controller, tests, and README. State the
fresh test counts and compile result, and summarize the exact Inspector work
needed to populate index 8 for the ninth seat.
