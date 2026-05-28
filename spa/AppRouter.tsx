import { Route, Switch } from 'wouter';

import AddressesPage from '@/app/addresses/page';
import ManagePage from '@/app/manage/page';
import HomePage from '@/app/page';
import SystemPage from '@/app/system/page';
import TokensPage from '@/app/tokens/page';

export function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/manage" component={ManagePage} />
      <Route path="/addresses" component={AddressesPage} />
      <Route path="/tokens" component={TokensPage} />
      <Route path="/system" component={SystemPage} />
      <Route>
        <HomePage />
      </Route>
    </Switch>
  );
}
