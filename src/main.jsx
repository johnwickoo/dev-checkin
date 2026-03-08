import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import VotePage from './VotePage.jsx'
import StatsPage from './StatsPage.jsx'

function TabNav({ tab, setTab }) {
  return (
    <nav className="tab-nav">
      <button
        className={`tab-btn ${tab === 'checkin' ? 'tab-active' : ''}`}
        onClick={() => setTab('checkin')}
      >
        Check-in
      </button>
      <button
        className={`tab-btn ${tab === 'stats' ? 'tab-active' : ''}`}
        onClick={() => setTab('stats')}
      >
        Stats
      </button>
    </nav>
  )
}

function Main() {
  const [tab, setTab] = useState('checkin')

  return (
    <>
      <TabNav tab={tab} setTab={setTab} />
      {tab === 'checkin' && <App />}
      {tab === 'stats' && <StatsPage />}
    </>
  )
}

function Router() {
  const path = window.location.pathname
  if (path === '/vote') return <VotePage />
  return <Main />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Router />
  </StrictMode>,
)
