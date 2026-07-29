(function (root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.ControlSettings = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SEAT_COUNT = 9;
    const AREA_NAMES = Object.freeze(['Main', 'T1', 'T2', 'T3', 'T4', 'Ground']);
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

    function createSeatSettings() {
        return Array.from({ length: SEAT_COUNT }, (_, index) => ({
            index,
            label: `座位 ${index + 1}`
        }));
    }

    return Object.freeze({
        SEAT_COUNT,
        AREA_NAMES,
        LIGHT_NAMES,
        LIGHT_LABELS,
        SEAT_MODES,
        isValidSeatMode,
        createSeatSettings
    });
}));
