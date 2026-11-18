import { useState } from 'react';
import { createRoot } from 'react-dom/client';

/** A real React app, because controlled inputs are where naive replay tools break. */
function App() {
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [plan, setPlan] = useState('free');
  const [items, setItems] = useState<string[]>([]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setItems([...items, `${name}/${plan}/${agreed}`]);
      }}
    >
      <input data-testid="react-name" value={name} onChange={(event) => setName(event.target.value)} />
      <label>
        <input data-testid="react-agree" type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        Agree
      </label>
      <select data-testid="react-plan" value={plan} onChange={(event) => setPlan(event.target.value)}>
        <option value="free">Free</option>
        <option value="pro">Pro</option>
      </select>
      <button data-testid="react-submit" type="submit" disabled={name.length === 0}>Add</button>
      <div data-testid="react-mirror">{name}</div>
      <ul data-testid="react-items">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </form>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
