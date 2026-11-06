import { GROUPS, GROUP_HELP, MODE_HELP, STATE_HELP, type FrameState, type GroupKey } from "./model";
import { ModeChip, StatePill } from "./FrameRail";

const STATES: FrameState[] = ["pending", "success", "rolled back", "reverted", "skipped"];
const GROUP_KEYS: GroupKey[] = ["verify", "out", "atomic"];

const Row = ({ chip, children }: { chip: React.ReactNode; children: React.ReactNode }) => (
  <div className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-x-3 gap-y-1 max-[520px]:grid-cols-1">
    <div>{chip}</div>
    <p className="m-0 text-[13px]/[20px] text-fg2">{children}</p>
  </div>
);

const Col = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-3">
    <h4 className="m-0 text-[13px] font-medium text-fg">{title}</h4>
    {children}
  </div>
);

/** What the chips on the rail mean: three modes, five states, three groups. */
export const FrameLegend = () => (
  <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-x-8 gap-y-6">
    <Col title="Modes: who runs the frame">
      {(Object.keys(MODE_HELP) as (keyof typeof MODE_HELP)[]).map((m) => <Row key={m} chip={<ModeChip mode={m} />}>{MODE_HELP[m]}</Row>)}
    </Col>
    <Col title="States: what happened to it">
      {STATES.map((s) => <Row key={s} chip={<StatePill state={s} />}>{STATE_HELP[s]}</Row>)}
    </Col>
    <Col title="Groups: where it sits">
      {GROUP_KEYS.map((g) => (
        <p key={g} className="m-0 text-[13px]/[20px] text-fg2"><span className="text-fg1">{GROUPS[g].title}.</span> {GROUP_HELP[g]}</p>
      ))}
    </Col>
  </div>
);
