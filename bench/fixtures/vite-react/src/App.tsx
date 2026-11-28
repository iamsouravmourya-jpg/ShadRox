import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="app">
      <h1 className="title">Hello Bench</h1>
      <p className="subtitle">A tiny fixture for the ShadRox bench.</p>
      <button className="counter" onClick={() => setCount((c) => c + 1)}>
        Count is {count}
      </button>
    </main>
  );
}