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
        createSeatSettings
    });
}));
