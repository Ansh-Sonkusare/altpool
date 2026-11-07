import { Codebase } from "./components/Codebase";
import { Doctor } from "./components/Doctor";
import { Hero } from "./components/Hero";
import { Install } from "./components/Install";
import { Nav } from "./components/Nav";
import { LivePledge } from "./components/LivePledge";
import { Footer, Why } from "./components/Static";
import { useDoctor, useEntity, useHeadBlock } from "./hooks";
import { PAY_RELAY } from "./live";

export const App = () => {
  const head = useHeadBlock();
  const { state: entity } = useEntity(PAY_RELAY);
  const doctor = useDoctor();

  return (
    <div className="relative mx-auto max-w-[1360px] overflow-x-clip border-x border-ln">
      <div className="pointer-events-none absolute -top-[180px] -right-[160px] h-[640px] w-[760px] max-w-full bg-[radial-gradient(closest-side,rgba(241,201,140,.16),rgba(241,201,140,.04)_55%,transparent)]" aria-hidden="true"></div>
      <Nav head={head} />
      <Hero head={head} />
      <LivePledge entity={entity} />
      <Codebase entity={entity} />
      <Doctor doctor={doctor} entity={entity} />
      <Install />
      <Why />
      <Footer entity={entity} />
    </div>
  );
};
