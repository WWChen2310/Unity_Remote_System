'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMadmapperConfig } = require('../control-model');

test('MadMapper config defines the required surface name and address mapping', () => {
  const config = require('../madmapper.config.json');
  const validated = validateMadmapperConfig(config);

  assert.deepEqual(
    validated.areas.map(({ name, oscAddress }) => ({ name, oscAddress })),
    [
      { name: 'Main', oscAddress: '/surfaces/Main/opacity' },
      { name: 'T1', oscAddress: '/surfaces/T1/opacity' },
      { name: 'T2', oscAddress: '/surfaces/T2/opacity' },
      { name: 'T3', oscAddress: '/surfaces/T3/opacity' },
      { name: 'T4', oscAddress: '/surfaces/T4/opacity' },
      { name: 'Ground', oscAddress: '/surfaces/Ground/opacity' },
    ],
  );
});
