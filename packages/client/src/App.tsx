import { NavLink, Route, Routes } from "react-router-dom";
import { RoastPage } from "./pages/RoastPage.tsx";
import { HistoryPage } from "./pages/HistoryPage.tsx";
import { RoastDetailPage } from "./pages/RoastDetailPage.tsx";

export function App() {
  return (
    <div className="app">
      <header className="app__header">
        <h1>Starmaya</h1>
        <nav className="app__nav">
          <NavLink to="/" end>Live</NavLink>
          <NavLink to="/roasts">History</NavLink>
        </nav>
      </header>
      <main className="app__main">
        <Routes>
          <Route path="/" element={<RoastPage />} />
          <Route path="/roasts" element={<HistoryPage />} />
          <Route path="/roasts/:id" element={<RoastDetailPage />} />
        </Routes>
      </main>
    </div>
  );
}
