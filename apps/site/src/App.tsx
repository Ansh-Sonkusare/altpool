import { AlsoBuilt } from "./components/AlsoBuilt";
import { Codebase } from "./components/Codebase";
import { Doctor } from "./components/Doctor";
import { Hero } from "./components/Hero";
import { Install } from "./components/Install";
import { Nav } from "./components/Nav";
import { LivePledge } from "./components/LivePledge";
import { Proof } from "./components/Proof";
import { Footer, Why } from "./components/Static";
import { useDoctor, useEntity, useHeadBlock } from "./hooks";
import { PAY_RELAY } from "./live";

export const App = () => {
  const head = useHeadBlock();
  const { state: entity } = useEntity(PAY_RELAY);
  const doctor = useDoctor();

  return (
    <div className="relative overflow-x-clip">
      <Nav head={head} />
      <Hero head={head} />
      <Proof />
      <Doctor doctor={doctor} entity={entity} />
      <LivePledge entity={entity} />
      <Codebase entity={entity} />
      <Install />
      <AlsoBuilt />
      <Why />
      <Footer entity={entity} />
    </div>
  );
};
