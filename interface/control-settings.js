(function (root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.ControlSettings = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // 座位上限。各投影方案實際用幾席由伺服器的方案目錄決定（s1 為 8、s2 為 9），
    // 投影區域清單也改由方案目錄提供，這裡不再寫死。
    const SEAT_COUNT = 9;
    // 工作燈與投影區域走同一條 MadMapper OSC 路徑，只是介面分開顯示。
    // 名稱要與 madmapper.config.json 的 lights 一致，OSC address 在那邊設定。
    const LIGHT_NAMES = Object.freeze(['Light1', 'Light2', 'Light3']);
    const LIGHT_LABELS = Object.freeze({ Light1: '燈 1', Light2: '燈 2', Light3: '燈 3' });

    // 座位個別控制的狀態。value 就是送給 Unity 的 tableModes 值，
    // 同時是 Unity StatusSetting.settings 的索引，兩邊順序不可各自調動。
    // 開燈（4）在 Unity 端會讓該區域變純白雲並停掉所有互動。
    const SEAT_MODES = Object.freeze([
        Object.freeze({ value: 0, label: '關燈' }),
        Object.freeze({ value: 1, label: '海洋' }),
        Object.freeze({ value: 2, label: '森林' }),
        Object.freeze({ value: 3, label: '液態食物' }),
        Object.freeze({ value: 4, label: '開燈' })
    ]);

    function isValidSeatMode(value) {
        return Number.isInteger(value) && value >= 0 && value < SEAT_MODES.length;
    }

    function createSeatSettings(count = SEAT_COUNT) {
        return Array.from({ length: count }, (_, index) => ({
            index,
            label: `座位 ${index + 1}`
        }));
    }

    /**
     * 某個方案可用的座位狀態，維持 SEAT_MODES 的順序。
     * labelOverrides 讓 s1 把 0 顯示成當時的「預設」，數值本身不變。
     */
    function seatModesFor(allowedValues, labelOverrides = {}) {
        return SEAT_MODES
            .filter(({ value }) => allowedValues.includes(value))
            .map(({ value, label }) => ({ value, label: labelOverrides[value] || label }));
    }

    /**
     * 座位面板在目前背景下能不能操作。伺服器與介面共用這一條規則，兩邊不會各自漂移。
     * seatOnlyInModes 非空時只在那些背景可用（s1 只在分割內容）；
     * seatLockedInModes 列出不可用的背景（s2 的稻田、水草）。
     */
    function isSeatPanelAvailable(profile, contentMode) {
        if (profile.seatOnlyInModes.length > 0 && !profile.seatOnlyInModes.includes(contentMode)) {
            return false;
        }
        return !profile.seatLockedInModes.includes(contentMode);
    }

    return Object.freeze({
        SEAT_COUNT,
        LIGHT_NAMES,
        LIGHT_LABELS,
        SEAT_MODES,
        isValidSeatMode,
        createSeatSettings,
        seatModesFor,
        isSeatPanelAvailable
    });
}));
