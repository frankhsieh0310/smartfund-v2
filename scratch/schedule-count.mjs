// offshore-nav-sync: 13 daily ticks (09:00-12:00 Taipei every 15min), ~170/tick observed
console.log('876 eligible funds / ~170 per 240s tick =', Math.ceil(876/170), 'ticks needed');
console.log('13 ticks/day available in the 09:00-12:00 window -> completes within', Math.ceil(876/170), 'of 13 ticks, same day');
