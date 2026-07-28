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

    function createSeatSettings() {
        return Array.from({ length: SEAT_COUNT }, (_, index) => ({
            index,
            label: `座位 ${index + 1}`
        }));
    }

    return Object.freeze({
        SEAT_COUNT,
        AREA_NAMES,
        createSeatSettings
    });
}));
