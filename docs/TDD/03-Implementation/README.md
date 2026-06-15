# Implementation Plans

This directory contains detailed technical execution plans for each development phase.

## 📚 Document Navigation

### Execution Plan Documents
- **[Phase 1: First Playable Slice](Phase1-ExecutionPlan.md)** - Technical implementation plan for the first playable prototype
- **[Phase 2: Survival Core](Phase2-ExecutionPlan.md)** *(To be created)*
- **[Phase 3: Economy & Social](Phase3-ExecutionPlan.md)** *(To be created)*
- **[Phase 4: Frontier Expansion](Phase4-ExecutionPlan.md)** *(To be created)*
- **[Phase 5: Automation & Launch](Phase5-ExecutionPlan.md)** *(To be created)*

## 🎯 Relationship with Other Documents

### 📖 Document Hierarchy

```
ROADMAP.md (High-level planning)
    ↓ "What features, why build them"
    ├─ Audience: PM, investors, designers, all team members
    ├─ Content: Product vision, feature list, player experience goals
    └─ Style: Concise, inspiring, readable

GDD/ (Game Design Documents)
    ↓ "Feature details, balance, player experience"
    ├─ Audience: Game designers, planners, artists
    ├─ Content: Gameplay mechanics, numerical balance, narrative design
    └─ Style: Detailed, visual, experience-focused

TDD/01-Architecture.md (System Architecture)
    ↓ "Overall technical approach, technology selection rationale"
    ├─ Audience: Tech leads, architects
    ├─ Content: Tech stack, architecture patterns, major technical decisions
    └─ Style: High-level, principle-based, decision-oriented

TDD/02-Systems/ (Subsystem Design)
    ↓ "Design solutions for each subsystem"
    ├─ Audience: System designers, senior engineers
    ├─ Content: Module design, data structures, algorithm choices
    └─ Style: Technical, reference-ready, independent modules

TDD/03-Implementation/ (Execution Plans) ⭐
    ↓ "How to build, step by step, with what tools"
    ├─ Audience: Frontline developers, engineers
    ├─ Content: Sprint tasks, technical design, concrete steps
    └─ Style: Actionable, step-by-step, progressive
```

## 📝 Execution Plan Document Standards

Each Phase execution plan should include:

### Required Sections
1. **Technical Goals** - Technical capabilities to be achieved in this phase
2. **Tech Stack Selection** - Specific libraries, frameworks, tool versions
3. **Sprint Breakdown** - Break down the Phase into 2-4 week sprint cycles
4. **Key Technical Decisions** - Document why certain technical solutions were chosen
5. **Performance Targets** - Quantifiable technical metrics
6. **Known Technical Risks** - Potential issues and mitigation measures
7. **Completion Criteria** - Technical and functional standards for Phase exit

### Optional Sections
- **Dependency Graphs** - Dependencies between tasks
- **Architecture Diagrams** - System component relationships
- **Testing Strategy** - Unit testing, integration testing plans
- **Deployment Plan** - Development environment, testing environment setup
- **Reference Resources** - Technical documentation, tutorial links

## 🔄 Workflow

### Development Process
```
1. Review ROADMAP.md
   └─ Understand the product goals for current Phase

2. Read corresponding Implementation Plan
   └─ Understand technical implementation path

3. Execute tasks in Sprint order
   └─ Demo and retrospective at end of each Sprint

4. When encountering problems
   └─ Consult TDD/01-Architecture.md (architecture level)
   └─ Consult TDD/02-Systems/ (system design level)
   └─ Update Implementation Plan (document solutions)

5. After Phase completion
   └─ Review and update execution plan
   └─ Summarize lessons learned
   └─ Plan next Phase
```

## 📊 Progress Tracking

Current progress is tracked by checkboxes in each Phase execution plan:

- [ ] Not started
- [x] Completed

Each Sprint should have clear deliverables and acceptance criteria.

## 🛠️ Maintenance Guidelines

### When to update execution plans?

**Must update:**
- ✅ When current plan proves infeasible
- ✅ When tech stack undergoes major changes
- ✅ After Sprint retrospectives
- ✅ When encountering new technical risks

**Recommended updates:**
- 💡 When learning new best practices
- 💡 When discovering better implementation methods
- 💡 When adding useful reference resources

### How to maintain document quality?

1. **Keep in sync** - Update documentation promptly after code implementation
2. **Document decisions** - Explain "why" not just "what"
3. **Be concise** - Avoid verbosity, highlight key points
4. **Version control** - All changes tracked via git commits
