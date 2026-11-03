//! The frames: every shape round-trips, the bytes are pinned, and nothing a
//! peer could send makes the decoder panic, run away or allocate on trust.

use super::*;
use std::io::Cursor;

fn ctx() -> Ctx {
    Ctx { room: "room-1".into(), t: "roulette-3".into(), inc: "c0123456789abcdef01234567".into() }
}

fn s(x: &str) -> String {
    x.to_string()
}

/// Values of every kind, nested, with text that is not ASCII.
fn values() -> Vec<CVal> {
    vec![
        CVal::Str(s("")),
        CVal::Str(s("héllo ✓ 🎲")),
        CVal::Int(0),
        CVal::Int(-1),
        CVal::Int(9_007_199_254_740_991),
        CVal::Int(i64::MIN),
        CVal::Undef,
        CVal::Junk,
        CVal::Arr(vec![]),
        CVal::Obj(vec![]),
        CVal::Arr(vec![CVal::Int(1), CVal::Junk, CVal::Undef, CVal::Str(s("x")), CVal::Arr(vec![CVal::Obj(vec![(s("k"), CVal::Int(2))])])]),
        // Fields in an order nothing sorts, a repeated name and `__proto__`: kept as they come.
        CVal::Obj(vec![(s("z"), CVal::Int(1)), (s("a"), CVal::Str(s("b"))), (s("z"), CVal::Junk), (s("__proto__"), CVal::Int(3)), (s(""), CVal::Undef)]),
    ]
}

fn requests() -> Vec<Req> {
    let vs = values();
    vec![
        Req::Cold(Cold { ctx: ctx(), version: 0, base: None, houses: vec![], pins: vec![], records: vec![] }),
        Req::Cold(Cold {
            ctx: ctx(),
            version: u64::MAX,
            base: Some(vs[10].clone()),
            houses: vec![s("hk1"), s("hk2")],
            pins: vec![(s("pid-a"), s("key-a")), (s("pid-b"), s("key-b"))],
            records: vs.iter().enumerate().map(|(i, v)| (format!("rec:{i}"), v.clone())).collect(),
        }),
        Req::Warm(Warm { ctx: ctx(), version: 7, houses: vec![], pins: vec![], changes: vec![] }),
        Req::Warm(Warm {
            ctx: ctx(),
            version: 8,
            houses: vec![s("hk1")],
            pins: vec![(s("pid-a"), s("key-a"))],
            changes: vec![(s("rec:1"), Some(vs[11].clone())), (s("rec:2"), None), (s("rec:3"), Some(CVal::Undef)), (s("rec:4"), Some(CVal::Junk))],
        }),
        Req::Forget { ctx: ctx() },
    ]
}

fn responses() -> Vec<Resp> {
    vec![
        Resp::Result { ctx: ctx(), version: 3, text: s("{\"v\":1}") },
        Resp::Result { ctx: ctx(), version: u64::MAX, text: s("") },
        Resp::Dirty { ctx: ctx(), version: 0, reason: s("fold out of memory") },
    ]
}

fn body(frame: &[u8]) -> &[u8] {
    assert_eq!(u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize, frame.len() - 4, "the byte count is the body's");
    &frame[4..]
}

#[test]
fn every_request_round_trips() {
    for r in requests() {
        let frame = encode_req(&r).unwrap();
        assert_eq!(decode_req(body(&frame)).unwrap(), r);
        // And through a pipe.
        let mut pipe = Cursor::new(frame.clone());
        let got = read_frame(&mut pipe).unwrap().unwrap();
        assert_eq!(got, frame[4..]);
        assert_eq!(read_frame(&mut pipe).unwrap(), None, "then the pipe is closed");
    }
}

#[test]
fn every_response_round_trips() {
    for r in responses() {
        let frame = encode_resp(&r).unwrap();
        assert_eq!(decode_resp(body(&frame)).unwrap(), r);
    }
}

#[test]
fn the_accessors_name_the_table_and_the_version() {
    let r = Resp::Dirty { ctx: ctx(), version: 9, reason: s("x") };
    assert_eq!((r.ctx(), r.version()), (&ctx(), 9));
    let r = Resp::Result { ctx: ctx(), version: 4, text: s("x") };
    assert_eq!((r.ctx(), r.version()), (&ctx(), 4));
}

#[test]
fn the_bytes_are_pinned() {
    // Both ends are this binary, but a change of layout must be a decision:
    // a worker and a node of different builds would not understand each other
    // (they cannot meet: the node starts its own file), and this is the record
    // of what the layout is.
    let c = Ctx { room: s("r"), t: s("t"), inc: s("i") };
    let frame = encode_req(&Req::Forget { ctx: c.clone() }).unwrap();
    assert_eq!(
        frame,
        [
            1 + 3 * 5, 0, 0, 0, // the body is 16 bytes
            3, // Forget
            1, 0, 0, 0, b'r', //
            1, 0, 0, 0, b't', //
            1, 0, 0, 0, b'i',
        ]
    );

    let frame = encode_req(&Req::Warm(Warm {
        ctx: c.clone(),
        version: 0x0102,
        houses: vec![s("h")],
        pins: vec![(s("p"), s("k"))],
        changes: vec![(s("a"), Some(CVal::Int(-2))), (s("b"), None), (s("c"), Some(CVal::Obj(vec![(s("f"), CVal::Junk)])))],
    }))
    .unwrap();
    let mut want: Vec<u8> = vec![];
    want.push(2); // Warm
    for x in ["r", "t", "i"] {
        want.extend_from_slice(&[1, 0, 0, 0, x.as_bytes()[0]]);
    }
    want.extend_from_slice(&[0x02, 0x01, 0, 0, 0, 0, 0, 0]); // version
    want.extend_from_slice(&[1, 0, 0, 0, 1, 0, 0, 0, b'h']); // houses
    want.extend_from_slice(&[1, 0, 0, 0, 1, 0, 0, 0, b'p', 1, 0, 0, 0, b'k']); // pins
    want.extend_from_slice(&[3, 0, 0, 0]); // changes
    want.extend_from_slice(&[1, 0, 0, 0, b'a', 1, 1, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]); // Int(-2)
    want.extend_from_slice(&[1, 0, 0, 0, b'b', 0]); // deleted
    want.extend_from_slice(&[1, 0, 0, 0, b'c', 1, 3, 1, 0, 0, 0, 1, 0, 0, 0, b'f', 5]); // { f: Junk }
    assert_eq!(&frame[4..], &want[..]);
    assert_eq!(frame[..4], (want.len() as u32).to_le_bytes());

    let frame = encode_resp(&Resp::Dirty { ctx: c, version: 1, reason: s("no") }).unwrap();
    let mut want: Vec<u8> = vec![0x82];
    for x in ["r", "t", "i"] {
        want.extend_from_slice(&[1, 0, 0, 0, x.as_bytes()[0]]);
    }
    want.extend_from_slice(&[1, 0, 0, 0, 0, 0, 0, 0]);
    want.extend_from_slice(&[2, 0, 0, 0, b'n', b'o']);
    assert_eq!(&frame[4..], &want[..]);
}

#[test]
fn a_frame_cut_anywhere_is_an_error_never_a_panic() {
    for r in requests() {
        let frame = encode_req(&r).unwrap();
        let b = body(&frame);
        for cut in 0..b.len() {
            assert!(decode_req(&b[..cut]).is_err(), "request cut at {cut} of {} decoded", b.len());
        }
    }
    for r in responses() {
        let frame = encode_resp(&r).unwrap();
        let b = body(&frame);
        for cut in 0..b.len() {
            assert!(decode_resp(&b[..cut]).is_err(), "response cut at {cut} of {} decoded", b.len());
        }
    }
}

#[test]
fn bytes_after_the_last_field_are_refused() {
    let frame = encode_req(&Req::Forget { ctx: ctx() }).unwrap();
    let mut b = body(&frame).to_vec();
    b.push(0);
    assert_eq!(decode_req(&b), Err(WireError::Trailing));
    let frame = encode_resp(&responses()[0]).unwrap();
    let mut b = body(&frame).to_vec();
    b.push(0);
    assert_eq!(decode_resp(&b), Err(WireError::Trailing));
}

#[test]
fn a_tag_that_names_nothing_is_refused() {
    assert_eq!(decode_req(&[0]), Err(WireError::BadTag(0)));
    assert_eq!(decode_req(&[4]), Err(WireError::BadTag(4)));
    assert_eq!(decode_req(&[0x81]), Err(WireError::BadTag(0x81)), "a response is not a request");
    assert_eq!(decode_resp(&[3]), Err(WireError::BadTag(3)), "a request is not a response");
    assert_eq!(decode_resp(&[]), Err(WireError::Truncated));
    // A bad value tag inside a record, and a bad presence flag.
    let mut b = vec![REQ_WARM];
    for x in ["r", "t", "i"] {
        b.extend_from_slice(&[1, 0, 0, 0, x.as_bytes()[0]]);
    }
    b.extend_from_slice(&[0; 8]); // version
    b.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]); // no houses, no pins
    b.extend_from_slice(&[1, 0, 0, 0, 1, 0, 0, 0, b'k', 1, 9]); // a record whose value tag is 9
    assert_eq!(decode_req(&b), Err(WireError::BadTag(9)));
    let n = b.len();
    b[n - 2] = 2; // a presence flag of 2
    assert_eq!(decode_req(&b), Err(WireError::BadTag(2)));
}

#[test]
fn a_string_that_is_not_utf8_is_refused() {
    let frame = encode_resp(&Resp::Dirty { ctx: ctx(), version: 1, reason: s("ab") }).unwrap();
    let mut b = body(&frame).to_vec();
    let n = b.len();
    b[n - 2] = 0xff; // the reason's first byte
    assert_eq!(decode_resp(&b), Err(WireError::BadUtf8));
    // A lone surrogate, as WTF-8 spells it, is not UTF-8 either: the node's
    // strings never hold one (they are Rust Strings).
    b[n - 2] = 0xed;
    b[n - 1] = 0xa0;
    assert!(decode_resp(&b).is_err());
}

/// The start of a request of this tag: the table and a version.
fn head(tag: u8) -> Vec<u8> {
    let mut b = vec![tag];
    for x in ["r", "t", "i"] {
        b.extend_from_slice(&[1, 0, 0, 0, x.as_bytes()[0]]);
    }
    b.extend_from_slice(&[0; 8]);
    b
}

/// A Warm with no houses and no pins and one record under "k" whose value starts with these bytes.
fn warm_with_value(value: &[u8]) -> Vec<u8> {
    let mut b = head(REQ_WARM);
    b.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]); // no houses, no pins
    b.extend_from_slice(&[1, 0, 0, 0]); // one change
    b.extend_from_slice(&[1, 0, 0, 0, b'k', 1]); // "k", present
    b.extend_from_slice(value);
    b
}

#[test]
fn a_count_larger_than_the_frame_is_refused_without_looping_toward_it() {
    let huge = u32::MAX.to_le_bytes();
    // Cold: no base, no houses, no pins, 4 billion records and no bytes for them.
    let mut b = head(REQ_COLD);
    b.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0]); // no base, no houses, no pins
    b.extend_from_slice(&huge);
    assert_eq!(decode_req(&b), Err(WireError::Truncated));
    // Houses: 4 billion of them. Pins: 4 billion.
    let mut b = head(REQ_WARM);
    b.extend_from_slice(&huge);
    assert_eq!(decode_req(&b), Err(WireError::Truncated));
    let mut b = head(REQ_WARM);
    b.extend_from_slice(&[0, 0, 0, 0]);
    b.extend_from_slice(&huge);
    assert_eq!(decode_req(&b), Err(WireError::Truncated));
    // Changes: 4 billion.
    let mut b = head(REQ_WARM);
    b.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
    b.extend_from_slice(&huge);
    assert_eq!(decode_req(&b), Err(WireError::Truncated));
    // An array of 4 billion, an object of 4 billion, a string of 4 GiB, in a record.
    for tag in [V_ARR, V_OBJ, V_STR] {
        let mut v = vec![tag];
        v.extend_from_slice(&huge);
        assert_eq!(decode_req(&warm_with_value(&v)), Err(WireError::Truncated), "tag {tag}");
    }
    // A count the bytes left could hold if each item took one byte, but each takes more.
    let mut v = vec![V_OBJ, 3, 0, 0, 0];
    v.extend_from_slice(&[0; 10]);
    assert_eq!(decode_req(&warm_with_value(&v)), Err(WireError::Truncated));
}

/// A request whose one record is a value nested `depth` deep, as bytes.
fn nested(depth: usize) -> Vec<u8> {
    let mut b = vec![REQ_WARM];
    for x in ["r", "t", "i"] {
        b.extend_from_slice(&[1, 0, 0, 0, x.as_bytes()[0]]);
    }
    b.extend_from_slice(&[0; 8]);
    b.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
    b.extend_from_slice(&[1, 0, 0, 0, 1, 0, 0, 0, b'k', 1]);
    for _ in 0..depth {
        b.extend_from_slice(&[V_ARR, 1, 0, 0, 0]);
    }
    b.push(V_UNDEF);
    b
}

#[test]
fn nesting_is_bounded() {
    // At the limit it decodes; a step past it is refused; and a million deep
    // is refused without the decoder's stack growing with it.
    assert!(decode_req(&nested(WIRE_DEPTH)).is_ok());
    assert_eq!(decode_req(&nested(WIRE_DEPTH + 1)), Err(WireError::TooDeep));
    assert_eq!(decode_req(&nested(1_000_000)), Err(WireError::TooDeep));
}

#[test]
fn a_value_that_nests_too_deep_is_not_sent() {
    let mut v = CVal::Undef;
    for _ in 0..=WIRE_DEPTH + 1 {
        v = CVal::Arr(vec![v]);
    }
    let r = Req::Warm(Warm { ctx: ctx(), version: 1, houses: vec![], pins: vec![], changes: vec![(s("k"), Some(v))] });
    assert_eq!(encode_req(&r), Err(WireError::TooDeep));
}

#[test]
fn a_frame_past_the_limit_is_not_sent() {
    let big = CVal::Str("x".repeat(MAX_FRAME));
    let r = Req::Warm(Warm { ctx: ctx(), version: 1, houses: vec![], pins: vec![], changes: vec![(s("k"), Some(big))] });
    assert!(matches!(encode_req(&r), Err(WireError::BadSize(n)) if n > MAX_FRAME));
    // One that just fits is sent.
    let fits = CVal::Str("x".repeat(MAX_FRAME - 200));
    let r = Req::Warm(Warm { ctx: ctx(), version: 1, houses: vec![], pins: vec![], changes: vec![(s("k"), Some(fits))] });
    let frame = encode_req(&r).unwrap();
    assert!(frame.len() - 4 <= MAX_FRAME);
    assert!(decode_req(&frame[4..]).is_ok());
}

#[test]
fn a_pipe_ending_between_frames_is_a_peer_that_is_done() {
    assert_eq!(read_frame(&mut Cursor::new(vec![])).unwrap(), None);
}

#[test]
fn a_pipe_ending_inside_a_frame_is_an_error() {
    for cut in 1..4 {
        let e = read_frame(&mut Cursor::new(vec![9, 0, 0, 0][..cut].to_vec())).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::UnexpectedEof, "cut inside the byte count at {cut}");
    }
    let e = read_frame(&mut Cursor::new(vec![5, 0, 0, 0, 1, 2, 3])).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::UnexpectedEof, "cut inside the body");
}

#[test]
fn a_frame_of_no_bytes_or_past_the_limit_is_refused_before_it_is_read() {
    let e = read_frame(&mut Cursor::new(vec![0, 0, 0, 0])).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::InvalidData);
    let too_big = (MAX_FRAME as u32 + 1).to_le_bytes().to_vec();
    let e = read_frame(&mut Cursor::new(too_big)).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::InvalidData);
    let e = read_frame(&mut Cursor::new(u32::MAX.to_le_bytes().to_vec())).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::InvalidData);
}

/// A reader that gives one byte at a time and an interruption between.
struct Drip {
    data: Vec<u8>,
    pos: usize,
    interrupt: bool,
}

impl Read for Drip {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.interrupt = !self.interrupt;
        if self.interrupt {
            return Err(io::ErrorKind::Interrupted.into());
        }
        if self.pos == self.data.len() || buf.is_empty() {
            return Ok(0);
        }
        buf[0] = self.data[self.pos];
        self.pos += 1;
        Ok(1)
    }
}

#[test]
fn frames_arrive_whole_however_the_pipe_hands_them_over() {
    let all = requests();
    let mut bytes = vec![];
    for r in &all {
        bytes.extend(encode_req(r).unwrap());
    }
    let mut pipe = Drip { data: bytes, pos: 0, interrupt: false };
    for want in &all {
        let got = decode_req(&read_frame(&mut pipe).unwrap().unwrap()).unwrap();
        assert_eq!(&got, want);
    }
    assert_eq!(read_frame(&mut pipe).unwrap(), None);
}

#[test]
fn write_frame_writes_it_whole_and_flushes() {
    struct Spy {
        data: Vec<u8>,
        flushed: usize,
    }
    impl Write for Spy {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            let n = b.len().min(3); // short writes
            self.data.extend_from_slice(&b[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.flushed += 1;
            Ok(())
        }
    }
    let frame = encode_resp(&responses()[0]).unwrap();
    let mut spy = Spy { data: vec![], flushed: 0 };
    write_frame(&mut spy, &frame).unwrap();
    assert_eq!(spy.data, frame);
    assert_eq!(spy.flushed, 1);
}

#[test]
fn nothing_a_peer_sends_panics_the_decoder() {
    // Valid frames with bytes changed, cut and padded, from a fixed seed.
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let frames: Vec<Vec<u8>> = requests().iter().map(|r| encode_req(r).unwrap()[4..].to_vec()).collect();
    let resps: Vec<Vec<u8>> = responses().iter().map(|r| encode_resp(r).unwrap()[4..].to_vec()).collect();
    let mut decoded = 0usize;
    for round in 0..20_000 {
        let src = if round % 4 == 0 { &resps[(next() % resps.len() as u64) as usize] } else { &frames[(next() % frames.len() as u64) as usize] };
        let mut b = src.clone();
        for _ in 0..(1 + next() % 4) {
            let i = (next() % b.len() as u64) as usize;
            match next() % 4 {
                0 => b[i] = next() as u8,
                1 => b[i] ^= 1 << (next() % 8),
                2 => {
                    b.truncate(i.max(1));
                }
                _ => b.insert(i, next() as u8),
            }
        }
        if round % 4 == 0 {
            decoded += decode_resp(&b).is_ok() as usize;
        } else {
            decoded += decode_req(&b).is_ok() as usize;
        }
    }
    // Some mutations (a changed digit of a version, a changed letter) still decode; most do not.
    assert!(decoded < 20_000);
}

#[test]
fn a_frame_being_refused_is_not_copied_past_the_limit() {
    // Three 20 MiB strings in one request: the second passes the limit, and neither it nor the
    // third is copied; the size it would have had is still told.
    let chunk = "x".repeat(20 << 20);
    let mut o = out();
    o.u8(REQ_WARM);
    for _ in 0..3 {
        o.str(&chunk);
    }
    assert!(o.b.len() <= FRAME_CAP, "{} bytes held", o.b.len());
    assert!(o.b.capacity() < 2 * FRAME_CAP, "and no more than a doubling was asked of the allocator");
    assert_eq!(o.total, 4 + 1 + 3 * (4 + (20 << 20)));
    assert!(matches!(o.finish(), Err(WireError::BadSize(n)) if n == 1 + 3 * (4 + (20 << 20))));
    // A frame of exactly the limit is sent whole.
    let mut o = out();
    o.bytes(&vec![7u8; MAX_FRAME]);
    assert_eq!(o.finish().unwrap().len(), 4 + MAX_FRAME);
    // One byte more is not.
    let mut o = out();
    o.bytes(&vec![7u8; MAX_FRAME + 1]);
    assert_eq!(o.b.len(), 4, "not even that byte's chunk is copied");
    assert!(matches!(o.finish(), Err(WireError::BadSize(n)) if n == MAX_FRAME + 1));
}

// ── Ids ─────────────────────────────────────────────────────────────────────

#[test]
fn a_room_table_or_incarnation_id_past_the_limit_is_not_sent() {
    let long = "r".repeat(MAX_CTX_FIELD + 1);
    for field in 0..3 {
        let mut c = ctx();
        match field {
            0 => c.room = long.clone(),
            1 => c.t = long.clone(),
            _ => c.inc = long.clone(),
        }
        assert_eq!(encode_req(&Req::Forget { ctx: c.clone() }), Err(WireError::BadSize(MAX_CTX_FIELD + 1)), "request, field {field}");
        let cold = Req::Cold(Cold { ctx: c.clone(), version: 1, base: None, houses: vec![], pins: vec![], records: vec![] });
        assert_eq!(encode_req(&cold), Err(WireError::BadSize(MAX_CTX_FIELD + 1)), "cold, field {field}");
        let resp = Resp::Dirty { ctx: c, version: 1, reason: s("x") };
        assert_eq!(encode_resp(&resp), Err(WireError::BadSize(MAX_CTX_FIELD + 1)), "answer, field {field}");
    }
}

#[test]
fn ids_of_exactly_the_limit_go_and_come_back() {
    let c = Ctx { room: "r".repeat(MAX_CTX_FIELD), t: "t".repeat(MAX_CTX_FIELD), inc: "é".repeat(MAX_CTX_FIELD / 2) };
    let req = Req::Forget { ctx: c.clone() };
    assert_eq!(decode_req(body(&encode_req(&req).unwrap())).unwrap(), req);
    let resp = Resp::Dirty { ctx: c, version: 7, reason: s("why") };
    assert_eq!(decode_resp(body(&encode_resp(&resp).unwrap())).unwrap(), resp);
}

#[test]
fn an_id_past_the_limit_is_refused_before_it_is_read() {
    // Only the length is there: it is refused as too long, not waited for as cut short.
    let claim = (MAX_CTX_FIELD as u32 + 1).to_le_bytes();
    let id = |n: usize| {
        let mut v = (n as u32).to_le_bytes().to_vec();
        v.extend(vec![b'x'; n]);
        v
    };
    for (tag, decode) in [(REQ_FORGET, 0), (RESP_DIRTY, 1)] {
        for field in 0..3 {
            let mut f = vec![tag];
            for _ in 0..field {
                f.extend(id(4));
            }
            f.extend(claim);
            let got = if decode == 0 { decode_req(&f).map(|_| ()) } else { decode_resp(&f).map(|_| ()) };
            assert_eq!(got, Err(WireError::BadSize(MAX_CTX_FIELD + 1)), "tag {tag:#04x}, field {field}");
        }
    }
}
