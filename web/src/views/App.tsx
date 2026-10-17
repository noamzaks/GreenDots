"use client"

import { AppShell } from "@mantine/core"
import { Route, Switch } from "wouter"
import { Header } from "@/components/Header"
import Activity from "./Activity"
import Home from "./Home"
import Log from "./Log"
import Project from "./Project"
import Run from "./Run"
import Settings from "./Settings"

export default function App() {
  return (
    <AppShell header={{ height: 52 }} padding="md">
      <Header />
      <AppShell.Main>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/activity" component={Activity} />
          <Route path="/settings" component={Settings} />
          <Route path="/project/:project" component={Project} />
          <Route path="/project/:project/run/:source/:run" component={Run} />
          <Route path="/project/:project/run/:source/:run/log" component={Log} />
        </Switch>
      </AppShell.Main>
    </AppShell>
  )
}
