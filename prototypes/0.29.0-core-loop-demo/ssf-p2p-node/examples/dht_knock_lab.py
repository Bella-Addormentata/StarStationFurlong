#!/usr/bin/env python3
"""Two home routers in network namespaces, for the DHT knock probe
(dht_knock_probe.rs). A test tool on the probe branch, never part of the game.

    dht 10.99.0.2 (a private DHT of server nodes) -- inet (routes only)
      |-- natA (wan 10.99.1.2, lan 192.168.10.1) -- hostA 192.168.10.2  holder
      |-- natB (wan 10.99.2.2, lan 192.168.20.1) -- hostB 192.168.20.2  newcomer

Each router masquerades its LAN and drops every packet from outside that no
packet from inside asked for, like a home router. Nothing here has a route to
the real internet, and every address is made up.

Scenarios:
  punch       the holder sends an opening dial to whoever its knock point
              lists: the newcomer must link.
  latedial    the same, with the newcomer's first dial held back 12 s, so the
              holder's opening dial is the first packet between the routers:
              the newcomer must link.
  nopunch     the holder sends nothing: the newcomer must NOT link (this is
              what shows the routers do block a one-sided dial).
  randomport  the newcomer's router changes the port on the way out: the
              newcomer must NOT link (the known limit, the same as a knock
              through the chain).

Needs root, Linux, nsenter, iptables and pyroute2.
Usage: dht_knock_lab.py <punch|nopunch|latedial|randomport> [newcomer_wait_secs]
       SSF_PROBE_BIN names the probe (default target/debug/examples/dht_knock_probe).
Exit: 0 when the scenario ended as it must, 1 when it did not.
"""
import os
import subprocess
import sys
import time

from pyroute2 import IPRoute, NetNS, netns

PROBE = os.path.abspath(os.environ.get('SSF_PROBE_BIN', 'target/debug/examples/dht_knock_probe'))
OUT = os.path.abspath(os.environ.get('SSF_LAB_OUT', 'dht-knock-lab-logs'))
MUST_LINK = {'punch': True, 'latedial': True, 'nopunch': False, 'randomport': False}
NS = ['ssfl-dht', 'ssfl-inet', 'ssfl-natA', 'ssfl-natB', 'ssfl-hostA', 'ssfl-hostB']
scenario = sys.argv[1] if len(sys.argv) > 1 else ''
wait = sys.argv[2] if len(sys.argv) > 2 else '60'


def sh(ns, *cmd, check=True):
    return subprocess.run(['nsenter', f'--net=/var/run/netns/{ns}', '--', *cmd], check=check, capture_output=True, text=True)


def veth(a_ns, a_if, a_ip, b_ns, b_if, b_ip):
    # Made under throwaway names in this namespace (which has an eth0 of its
    # own), moved, then given their real names where they live.
    ta, tb = 'ssfl-ta', 'ssfl-tb'
    ipr = IPRoute()
    ipr.link('add', ifname=ta, kind='veth', peer={'ifname': tb})
    ipr.link('set', index=ipr.link_lookup(ifname=ta)[0], net_ns_fd=a_ns)
    ipr.link('set', index=ipr.link_lookup(ifname=tb)[0], net_ns_fd=b_ns)
    ipr.close()
    for ns_name, tmp, ifname, ip in ((a_ns, ta, a_if, a_ip), (b_ns, tb, b_if, b_ip)):
        ns = NetNS(ns_name)
        idx = ns.link_lookup(ifname=tmp)[0]
        ns.link('set', index=idx, ifname=ifname)
        ns.addr('add', index=idx, address=ip, prefixlen=24)
        ns.link('set', index=idx, state='up')
        ns.close()


def default_route(ns_name, gw):
    ns = NetNS(ns_name)
    ns.route('add', dst='default', gateway=gw)
    ns.close()


def teardown():
    for name in NS:
        try:
            netns.remove(name)
        except Exception:
            pass


def spawn(ns, log, *args, env=None):
    f = open(f'{OUT}/{scenario}-{log}.log', 'w')
    e = dict(os.environ, SSF_PROBE_FULL_ADDRS='1', **(env or {}))
    return subprocess.Popen(['nsenter', f'--net=/var/run/netns/{ns}', '--', PROBE, *args], stdout=f, stderr=subprocess.STDOUT, env=e)


def main():
    if scenario not in MUST_LINK:
        print(__doc__)
        return 2
    os.makedirs(OUT, exist_ok=True)
    teardown()
    try:
        return run()
    finally:
        teardown()


def run():
    for name in NS:
        netns.create(name)
        ns = NetNS(name)
        ns.link('set', index=ns.link_lookup(ifname='lo')[0], state='up')
        ns.close()
    veth('ssfl-inet', 'id', '10.99.0.1', 'ssfl-dht', 'eth0', '10.99.0.2')
    default_route('ssfl-dht', '10.99.0.1')
    veth('ssfl-inet', 'ia', '10.99.1.1', 'ssfl-natA', 'wan', '10.99.1.2')
    veth('ssfl-inet', 'ib', '10.99.2.1', 'ssfl-natB', 'wan', '10.99.2.2')
    veth('ssfl-natA', 'lan', '192.168.10.1', 'ssfl-hostA', 'eth0', '192.168.10.2')
    veth('ssfl-natB', 'lan', '192.168.20.1', 'ssfl-hostB', 'eth0', '192.168.20.2')
    default_route('ssfl-natA', '10.99.1.1')
    default_route('ssfl-natB', '10.99.2.1')
    default_route('ssfl-hostA', '192.168.10.1')
    default_route('ssfl-hostB', '192.168.20.1')
    for router in ('ssfl-inet', 'ssfl-natA', 'ssfl-natB'):
        sh(router, 'sh', '-c', 'echo 1 > /proc/sys/net/ipv4/ip_forward')
    for router in ('ssfl-natA', 'ssfl-natB'):
        masq = ['iptables', '-t', 'nat', '-A', 'POSTROUTING', '-o', 'wan', '-j', 'MASQUERADE']
        if scenario == 'randomport' and router == 'ssfl-natB':
            masq.append('--random-fully')
        sh(router, *masq)
        sh(router, 'iptables', '-P', 'FORWARD', 'DROP')
        sh(router, 'iptables', '-A', 'FORWARD', '-i', 'lan', '-o', 'wan', '-j', 'ACCEPT')
        sh(router, 'iptables', '-A', 'FORWARD', '-i', 'wan', '-o', 'lan', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT')
        sh(router, 'iptables', '-P', 'INPUT', 'DROP')
        sh(router, 'iptables', '-A', 'INPUT', '-i', 'lan', '-j', 'ACCEPT')
        sh(router, 'iptables', '-A', 'INPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT')

    procs = []
    try:
        procs.append(spawn('ssfl-dht', 'dht', 'dht', '10.99.0.2', '6881', '12'))
        time.sleep(3)
        mode = 'nopunch' if scenario == 'nopunch' else 'punch'
        holder = spawn('ssfl-hostA', 'holder', 'holder', '10.99.0.2:6881', mode, '-', env={'SSF_PROBE_LIFE_SECS': str(int(wait) + 30)})
        procs.append(holder)
        holder_id = None
        deadline = time.time() + 20
        while time.time() < deadline and not holder_id:
            time.sleep(0.5)
            for line in open(f'{OUT}/{scenario}-holder.log'):
                if line.startswith('ID '):
                    holder_id = line.split()[1]
        if not holder_id:
            print('holder never printed its id')
            return 2
        time.sleep(6)  # the holder's first door announce
        newcomer = spawn('ssfl-hostB', 'newcomer', 'newcomer', '10.99.0.2:6881', holder_id, '-', wait, env={'SSF_PROBE_DIAL_DELAY_SECS': '12'} if scenario == 'latedial' else None)
        procs.append(newcomer)
        code = newcomer.wait(timeout=int(wait) + 40)
        time.sleep(1.5)
        linked = code == 0
        as_it_must = linked == MUST_LINK[scenario]
        print(f'scenario {scenario}: linked={linked}, must link={MUST_LINK[scenario]}: {"OK" if as_it_must else "NOT AS EXPECTED"}')
        for who in ('holder', 'newcomer'):
            print(f'--- {who}')
            for line in open(f'{OUT}/{scenario}-{who}.log'):
                if not line.startswith('ID '):
                    print('  ' + line.rstrip()[:200])
        return 0 if as_it_must else 1
    finally:
        for p in procs:
            if p.poll() is None:
                p.kill()  # this script's own children, by their handles
                p.wait()
        teardown()


if __name__ == '__main__':
    sys.exit(main())
