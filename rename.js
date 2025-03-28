const fs = require('fs');
const path = require('path');

const order = [
  'mario', 'donkey', 'link', 'samus', 'samusd', 'yoshi', 'kirby', 'fox', 'pikachu', 'luigi',
  'ness', 'captain', 'purin', 'peach', 'daisy', 'koopa', 'ice_climber', 'sheik', 'zelda', 'mariod',
  'pichu', 'falco', 'marth', 'lucina', 'younglink', 'ganon', 'mewtwo', 'roy', 'chrom', 'gamewatch',
  'metaknight', 'pit', 'pitb', 'szerosuit', 'wario', 'snake', 'ike', 'ptrainer', 'diddy', 'lucas',
  'sonic', 'dedede', 'pikmin', 'lucario', 'robot', 'toonlink', 'wolf', 'murabito', 'rockman', 'wiifit',
  'rosetta', 'littlemac', 'gekkouga', 'miifighter', 'miiswordsman', 'miigunner', 'palutena', 'pacman',
  'reflet', 'shulk', 'koopajr', 'duckhunt', 'ryu', 'ken', 'cloud', 'kamui', 'bayonetta', 'inkling',
  'ridley', 'simon', 'richter', 'krool', 'shizue', 'gaogaen', 'packun', 'jack', 'brave', 'buddy',
  'terry', 'master', 'tantan', 'pickel', 'edge', 'eflame', 'elight', 'demon', 'trail'
];
const dir = './public/characters';

order.forEach((name, index) => {
  const oldPath = path.join(dir, `${name}.png`);
  const newName = `${String(index + 1).padStart(2, '0')}_${name}.png`;
  const newPath = path.join(dir, newName);
  if (fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, newPath);
    console.log(`リネーム: ${oldPath} -> ${newPath}`);
  } else {
    console.log(`未発見: ${name}.png`);
  }
});
console.log('リネーム完了');