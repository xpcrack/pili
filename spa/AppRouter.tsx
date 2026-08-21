import { Route, Switch } from 'wouter';

import HomePage from '@/app/page';
import PublicFeedPage from '@/app/public-feed/page';
import RankingPage from '@/app/ranking/page';

export function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/public-feed" component={PublicFeedPage} />
      <Route path="/ranking" component={RankingPage} />
      <Route>
        <HomePage />
      </Route>
    </Switch>
  );
}
