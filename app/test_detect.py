#!/usr/bin/env python3
"""
Detector regression tests. Run: python3 -m unittest discover -s tests

These exist because a detector that fires on everything is worthless and a
detector that fires on nothing is worse. Every case below is a real shape:
one must be caught, the other must stay silent.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import detect  # noqa: E402

VULNERABLE = """
pragma solidity ^0.8.20;
contract V {
    mapping(address => uint256) public shares;
    uint256 public totalShares;
    address public owner;
    address public implementation;

    function initialize(address o) public {
        owner = o;
    }

    function setImplementation(address impl) external {
        implementation = impl;
    }

    function exec(bytes calldata data) external {
        (bool ok, ) = implementation.delegatecall(data);
        require(ok);
    }

    function withdraw() external {
        uint256 bal = shares[msg.sender];
        (bool ok, ) = msg.sender.call{value: bal}("");
        require(ok);
        shares[msg.sender] = 0;
    }
}
"""

SAFE = """
pragma solidity ^0.8.20;
contract S {
    mapping(address => uint256) private _shares;
    address private immutable _impl;

    function initialize(address) external onlyOwner initializer {
        revert("done");
    }

    function setFee(uint256) external onlyOwner {
    }

    function withdraw() external nonReentrant {
        uint256 bal = _shares[msg.sender];
        _shares[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: bal}("");
        require(ok);
    }
}
"""


class DetectorTest(unittest.TestCase):
    def _scan(self, source: str) -> list[detect.Lead]:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "C.sol").write_text(source)
            out: list[detect.Lead] = []
            for p in root.rglob("*.sol"):
                out.extend(detect.scan_file(p, root))
            return out

    def test_unguarded_initializer_is_caught(self) -> None:
        ids = {l.playbook for l in self._scan(VULNERABLE)}
        self.assertIn("sol.upgrade", ids)

    def test_delegatecall_is_caught(self) -> None:
        self.assertIn("sol.delegatecall", {l.playbook for l in self._scan(VULNERABLE)})

    def test_reentrancy_shape_without_mutex_is_caught(self) -> None:
        self.assertIn("sol.reentrancy", {l.playbook for l in self._scan(VULNERABLE)})

    def test_missing_access_control_is_caught(self) -> None:
        self.assertIn("sol.accesscontrol", {l.playbook for l in self._scan(VULNERABLE)})

    def test_guarded_initializer_is_silent(self) -> None:
        self.assertNotIn("sol.upgrade", {l.playbook for l in self._scan(SAFE)})

    def test_onlyowner_functions_are_silent(self) -> None:
        self.assertNotIn("sol.accesscontrol", {l.playbook for l in self._scan(SAFE)})

    def test_nonreentrant_is_silent(self) -> None:
        self.assertNotIn("sol.reentrancy", {l.playbook for l in self._scan(SAFE)})

    def test_checks_effects_interactions_is_silent(self) -> None:
        cei = """
pragma solidity ^0.8.20;
contract C {
    mapping(address => uint256) public bal;
    function out() external {
        uint256 a = bal[msg.sender];
        bal[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok);
    }
}
"""
        self.assertNotIn("sol.reentrancy", {l.playbook for l in self._scan(cei)})

    def test_commented_out_code_does_not_fire(self) -> None:
        commented = """
pragma solidity ^0.8.20;
contract C {
    // address public implementation;
    /* function initialize(address o) public { owner = o; } */
}
"""
        self.assertEqual(self._scan(commented), [])

    def test_view_functions_do_not_fire_state_patterns(self) -> None:
        view = """
pragma solidity ^0.8.20;
contract C {
    function peek() external view returns (bytes memory) {
        return msg.sender.call{value: 0}("");
    }
}
"""
        self.assertNotIn("sol.reentrancy", {l.playbook for l in self._scan(view)})

    def test_clean_contract_yields_nothing(self) -> None:
        self.assertEqual(self._scan(SAFE), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
