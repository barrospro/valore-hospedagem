const fs = require('fs');
const c = fs.readFileSync('public/assets/index-v11.js', 'utf8');

// Search for "Execuções" near "Templates" or "Mídias" to find the tab container
const terms = ['Execuções', 'Templates', 'Mídias', 'Links'];
let foundIdx = -1;

for (const term of terms) {
  // Try finding it as a child property or label
  const patterns = [
    `children:"${term}"`,
    `label:"${term}"`,
    `title:"${term}"`
  ];
  
  for (const p of patterns) {
    const idx = c.indexOf(p);
    if (idx !== -1) {
      console.log(`Found "${term}" with pattern "${p}" at index:`, idx);
      // Print context
      console.log('Context:', c.substring(Math.max(0, idx - 200), idx + 200));
      foundIdx = idx;
      break;
    }
  }
  if (foundIdx !== -1) break;
}

if (foundIdx === -1) {
  console.log('Could not find tab definitions with standard patterns.');
  // Fallback: search for just the string
  const idx = c.indexOf('Execuções');
  if (idx !== -1) {
     console.log('Fallback found "Execuções" at:', idx);
     console.log('Context:', c.substring(Math.max(0, idx - 100), idx + 100));
  }
}