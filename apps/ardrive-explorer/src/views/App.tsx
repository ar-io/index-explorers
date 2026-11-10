/**
 * The app shell, as ArDrive web lays out its own: the app bar across the top,
 * the nav down the left, and one view at a time in the content area.
 */
import { useState } from 'preact/hooks';

import { useApp } from '../context.js';
import { sectionOf } from '../router.js';
import { DrivesView, HomeView, QuestionsView, SourceView, SqlView } from './Sections.js';
import { SideNav } from './SideNav.js';
import { TopBar } from './TopBar.js';

export function App() {
  const { store } = useApp();
  const section = sectionOf(store.view.value, store.asked.value);
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div class="shell">
      <a class="skip" href="#explore">
        Skip to content
      </a>
      <TopBar navOpen={navOpen} onMenu={() => setNavOpen(!navOpen)} />
      <div class="shell-body">
        <SideNav section={section} open={navOpen} onClose={() => setNavOpen(false)} />
        <main class="content" id="explore" tabIndex={-1} data-section={section}>
          {section === 'home' ? (
            <HomeView />
          ) : section === 'drives' ? (
            <DrivesView />
          ) : section === 'questions' ? (
            <QuestionsView />
          ) : section === 'sql' ? (
            <SqlView />
          ) : (
            <SourceView />
          )}
        </main>
      </div>
    </div>
  );
}
