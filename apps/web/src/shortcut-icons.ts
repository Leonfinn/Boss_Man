// The menu icon for each pinnable page, by the icon name the shared list (packages/shared shortcuts.ts) carries.
// Named imports, so only these icons reach the bundle (not lucide's whole name table).
import { Activity, ArrowLeftRight, Bell, CheckCheck, Cpu, Dog, Download, Gauge, Handshake, IdCard, Key, ListChecks, Mail, Map, MessageCircle, Plug, Puzzle, Server, Shield, ShieldCheck, Smartphone, Sparkles, UserCog, Users, Wallet, Workflow, type LucideIcon } from "lucide-react";

export const SHORTCUT_ICONS: Record<string, LucideIcon> = {
  map: Map,
  sparkles: Sparkles,
  "message-circle": MessageCircle,
  "list-checks": ListChecks,
  users: Users,
  puzzle: Puzzle,
  handshake: Handshake,
  activity: Activity,
  "shield-check": ShieldCheck,
  workflow: Workflow,
  wallet: Wallet,
  key: Key,
  "id-card": IdCard,
  bell: Bell,
  plug: Plug,
  "check-check": CheckCheck,
  "user-cog": UserCog,
  dog: Dog,
  shield: Shield,
  download: Download,
  gauge: Gauge,
  cpu: Cpu,
  mail: Mail,
  server: Server,
  smartphone: Smartphone,
  "arrow-left-right": ArrowLeftRight,
};
