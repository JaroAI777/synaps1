// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/**
 * @title MockERC721
 * @notice Mock ERC721 for testing
 */
contract MockERC721 is ERC721 {
    uint256 private _tokenIdCounter;

    constructor(string memory name, string memory symbol) ERC721(name, symbol) {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function safeMint(address to) external returns (uint256) {
        uint256 tokenId = _tokenIdCounter++;
        _safeMint(to, tokenId);
        return tokenId;
    }

    function batchMint(address to, uint256 count) external {
        for (uint256 i = 0; i < count; i++) {
            _mint(to, _tokenIdCounter++);
        }
    }
}

/**
 * @title MockERC1155
 * @notice Mock ERC1155 for testing
 */
contract MockERC1155 is ERC1155 {
    constructor() ERC1155("https://api.synapse.ai/nft/{id}.json") {}

    function mint(address to, uint256 id, uint256 amount, bytes memory data) external {
        _mint(to, id, amount, data);
    }

    function mintBatch(
        address to,
        uint256[] memory ids,
        uint256[] memory amounts,
        bytes memory data
    ) external {
        _mintBatch(to, ids, amounts, data);
    }
}

/**
 * @title MockPriceOracle
 * @notice Mock price oracle for testing
 */
contract MockPriceOracle {
    mapping(address => uint256) public prices;
    
    function setPrice(address token, uint256 price) external {
        prices[token] = price;
    }
    
    function getPrice(address token) external view returns (uint256) {
        return prices[token];
    }
    
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return (1, 100000000, block.timestamp, block.timestamp, 1); // $1.00 with 8 decimals
    }
}

/**
 * @title MockStrategy
 * @notice Mock yield strategy for testing vault
 */
contract MockStrategy {
    IERC20 public asset;
    uint256 public deposited;
    uint256 public profit;
    
    constructor(address _asset) {
        asset = IERC20(_asset);
    }
    
    function deposit(uint256 amount) external {
        asset.transferFrom(msg.sender, address(this), amount);
        deposited += amount;
    }
    
    function withdraw(uint256 amount) external returns (uint256) {
        require(amount <= deposited, "Insufficient balance");
        deposited -= amount;
        asset.transfer(msg.sender, amount);
        return amount;
    }
    
    function harvest() external returns (uint256) {
        uint256 earned = profit;
        profit = 0;
        return earned;
    }
    
    function setProfit(uint256 _profit) external {
        profit = _profit;
    }
    
    function balanceOf() external view returns (uint256) {
        return deposited + profit;
    }
    
    function emergencyWithdraw() external {
        uint256 balance = asset.balanceOf(address(this));
        asset.transfer(msg.sender, balance);
        deposited = 0;
    }
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title MockRouter
 * @notice Mock DEX router for testing
 */
contract MockRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountIn; // 1:1 swap for testing
        
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        IERC20(path[path.length - 1]).transfer(to, amountIn);
        
        return amounts;
    }
    
    function getAmountsOut(uint256 amountIn, address[] calldata path) 
        external pure returns (uint256[] memory amounts) 
    {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountIn; // 1:1 for testing
    }
}

/**
 * @title MockWETH
 * @notice Mock WETH for testing
 */
contract MockWETH {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8 public decimals = 18;
    
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Approval(address indexed owner, address indexed spender, uint256 wad);
    
    receive() external payable {
        deposit();
    }
    
    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }
    
    function withdraw(uint256 wad) public {
        require(balanceOf[msg.sender] >= wad, "Insufficient balance");
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
        emit Withdrawal(msg.sender, wad);
    }
    
    function totalSupply() public view returns (uint256) {
        return address(this).balance;
    }
    
    function approve(address guy, uint256 wad) public returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }
    
    function transfer(address dst, uint256 wad) public returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }
    
    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "Insufficient balance");
        
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, "Insufficient allowance");
            allowance[src][msg.sender] -= wad;
        }
        
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        
        emit Transfer(src, dst, wad);
        return true;
    }
}
