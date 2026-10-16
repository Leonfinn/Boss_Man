# Feature requests

A place for what people ask each company to build, how much it matters to them, and what gets built next. Inspired by Productboard. It's proprietary software, so the ideas below are borrowed and the design and code are Boss Man's own.

Checked on 16 Oct 2026 against Productboard's help centre and public portals:
- [insights](https://support.productboard.com/hc/en-us/articles/360056354514);
- [drivers scored 0 to 5](https://support.productboard.com/hc/en-us/articles/360056348954);
- [the portal](https://www.productboard.com/product-portal-2/);
- an example of portal voting with Nice-to-have, Important and Critical ([Sonar](https://blog.sonarsource.com/product-portals-open-we-want-your-input)).

## Ideas taken

| Productboard | Boss Man |
|---|---|
| **Notes**: feedback as it arrived | **Feedback** notes per company. A note comes from you, the owner chat, an agent, the portal, email or an import, and is unprocessed, processed or archived. |
| **Insights**: a highlighted passage linked to a feature, with importance | The same. Importance is Nice to have (1), Important (2) or Critical (3). Linking the same note to the same feature again updates it. |
| **User impact score** | **Demand.** The sum of importance, but each customer counts once per feature, at the most important level they asked for. One loud customer can't outweigh many quiet ones. A feature's demand includes its subfeatures'. |
| **Drivers** scored 0 to 5, with a **prioritisation formula** | **Criteria** per company, each with a weight (0 to 10), scored 0 to 5 per feature. **Value** is the weighted average of demand (scaled so the most wanted feature is 5) and the scored criteria. **Priority** is value × 3 ÷ effort (1 to 5; unsized counts as 3). |
| **Hierarchy**: product, component, feature, subfeature | Area, feature, subfeature (one level). |
| **Portal**: vote, suggest, see what's planned and launched | Opt-in, behind a secret link. Visitors vote with an importance, can add a comment, and can suggest ideas. Everything they send is treated as untrusted. |
| **AI-suggested links** | A plain word-match suggestion of features a note may be about. It's not AI, and it's meant as a starting point. |

## Boss Man's own additions

- **Agents.**
  - The CEO can triage feedback through MCP: list unprocessed notes, link them to features, create features and log feedback it hears.
  - It can do this on its own when new feedback arrives (off by default, because it costs a run).
  - The owner chat can file feedback.
- **Delivery.**
  - Tickets can deliver a feature, and a feature shows how many of its tickets are done.
  - A feature moves to in progress when work on it starts, and to released when its last ticket is done.
  - A feature can belong to a roadmap milestone.

## Status

1. Server: notes, insights, features, areas, criteria, customers and scoring. **In review.**
2. Web: the feedback inbox (select a passage, pick or create a feature, set importance), the features list with inline prioritisation, and the feature page. **In review.**
3. Agents and tickets.
4. The portal.
