const fs = require('fs');
const path = require('path');

const dir = './public/characters';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png'));

files.forEach((file, index) => {
  const oldPath = path.join(dir, file);
  const newName = `${String(index + 1).padStart(2, '0')}.png`;
  const newPath = path.join(dir, newName);
  fs.renameSync(oldPath, newPath);
  console.log(`リネーム: ${file} -> ${newName}`);
});
console.log('リネーム完了');